import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { createGatewayTransport, type PendingBatch, type Transmission } from './transport';

const WINDOW_MS = 300_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const batch = (index: number): PendingBatch => ({ seq: index * 100, windowEndMs: T0 + (index + 1) * WINDOW_MS, samples: [], events: [] });

function pushAll(transport: ReturnType<typeof createGatewayTransport>, count: number): Transmission[] {
  const sent: Transmission[] = [];
  for (let i = 0; i < count; i += 1) sent.push(...transport.push(batch(i)));
  return [...sent, ...transport.finish()];
}

describe('createGatewayTransport', () => {
  it('정상일 때 배치마다 한 번, 창 끝 직후에 보낸다', () => {
    const sent = pushAll(createGatewayTransport({ outages: [], duplicateRatio: 0 }, createRng(1)), 10);

    expect(sent.map((t) => t.batch.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i * 100));
    sent.forEach((t) => {
      expect(t.sentAtMs).toBeGreaterThan(t.batch.windowEndMs);
      expect(t.sentAtMs).toBeLessThan(t.batch.windowEndMs + 2_000);
      expect(t).toMatchObject({ resend: false, backfill: false });
    });
  });

  it('통신 단절 동안 보류하고, 끝나면 최신 배치부터 역순으로 백필한 뒤 실시간 전송을 잇는다', () => {
    const outage = { startMs: T0 + 3 * WINDOW_MS, endMs: T0 + 6 * WINDOW_MS + 30_000 };
    const transport = createGatewayTransport({ outages: [outage], duplicateRatio: 0 }, createRng(2));
    const sent = pushAll(transport, 10);
    const seqs = sent.map((t) => t.batch.seq / 100);

    // 창 2,3,4,5의 전송 시각(창 끝)이 단절 구간에 들어간다 → 5,4,3,2 순서로 백필
    expect(seqs).toEqual([0, 1, 5, 4, 3, 2, 6, 7, 8, 9]);
    expect(sent.filter((t) => t.backfill).map((t) => t.batch.seq / 100)).toEqual([5, 4, 3, 2]);
    sent.filter((t) => t.backfill).forEach((t) => expect(t.sentAtMs).toBeGreaterThanOrEqual(outage.endMs));
    sent.slice(1).forEach((t, i) => expect(t.sentAtMs).toBeGreaterThan(sent[i]?.sentAtMs ?? Infinity));
    expect(sent.some((t) => !t.backfill && t.sentAtMs >= outage.startMs && t.sentAtMs < outage.endMs)).toBe(false);
  });

  it('실행이 단절 중에 끝나면 finish가 보류분을 역순으로 보낸다', () => {
    const transport = createGatewayTransport({ outages: [{ startMs: T0 + 5 * WINDOW_MS, endMs: T0 + 100 * WINDOW_MS }], duplicateRatio: 0 }, createRng(3));
    const live = [0, 1, 2, 3, 4, 5, 6].flatMap((i) => transport.push(batch(i)));
    const flushed = transport.finish();

    expect(live.map((t) => t.batch.seq / 100)).toEqual([0, 1, 2, 3]);
    expect(flushed.map((t) => t.batch.seq / 100)).toEqual([6, 5, 4]);
  });

  it('중복 비율 1이면 모든 배치를 본문 그대로 한 번 더 보낸다', () => {
    const sent = pushAll(createGatewayTransport({ outages: [], duplicateRatio: 1 }, createRng(4)), 3);

    expect(sent.map((t) => [t.batch.seq, t.resend])).toEqual([
      [0, false],
      [0, true],
      [100, false],
      [100, true],
      [200, false],
      [200, true],
    ]);
    expect(sent[1]?.batch).toBe(sent[0]?.batch);
  });
});
