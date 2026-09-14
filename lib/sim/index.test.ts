import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import type { IngestSeries } from './envelope';
import { simulate, type SimulateOptions, type SimulatedBatch } from './index';
import { MS_PER_HOUR } from './math';

const FROM = Date.parse('2026-08-20T00:00:00+09:00');
const ONE_DAY = { from: FROM, to: FROM + 24 * MS_PER_HOUR };

async function collect(options: SimulateOptions): Promise<SimulatedBatch[]> {
  const batches: SimulatedBatch[] = [];
  for await (const batch of simulate(options)) batches.push(batch);
  return batches;
}

const sum = (batches: readonly SimulatedBatch[], pick: (b: SimulatedBatch) => number) => batches.reduce((s, b) => s + pick(b), 0);
const seriesLength = (series: IngestSeries) => series.v.length;
const timestamps = (series: IngestSeries): number[] => ('ts' in series ? [...series.ts] : series.v.map((_, i) => series.t0 + i * series.dt));

/** 사이트 하루치 이론 샘플 수 (매핑 포인트) */
function dailyMappedSamples(code: string): number {
  const site = SIM_SITES.find((s) => s.code === code);
  return (site?.assets ?? []).flatMap((a) => a.points).reduce((s, p) => s + 86_400 / p.periodS, 0);
}

describe('simulate — 하루 3사이트 (healthy)', () => {
  let batches: SimulatedBatch[] = [];
  let elapsedMs = 0;

  beforeAll(async () => {
    const started = performance.now();
    batches = await collect({ siteCodes: ['SIM-A', 'SIM-B', 'SIM-C'], ...ONE_DAY, seed: 42 });
    elapsedMs = performance.now() - started;
  }, 60_000);

  it('실행시간: 3사이트 × 1440스텝이 수 초 안에 끝난다', () => {
    console.info(`[sim] 1일 × 3사이트 × 1440스텝: ${elapsedMs.toFixed(0)} ms, 봉투 ${batches.length}개`);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('expectedSamples 합이 포인트별 하루 이론 샘플 수와 정확히 같다', () => {
    for (const code of ['SIM-A', 'SIM-B', 'SIM-C']) {
      const siteBatches = batches.filter((b) => b.siteCode === code);
      expect(sum(siteBatches, (b) => b.expectedSamples), code).toBe(dailyMappedSamples(code));
    }
    expect(sum(batches.filter((b) => b.siteCode === 'SIM-B'), (b) => b.expectedUnmappedSamples)).toBe(2 * 288);
    expect(sum(batches.filter((b) => b.siteCode !== 'SIM-B'), (b) => b.expectedUnmappedSamples)).toBe(0);
  });

  it('봉투는 om.ingest.v1 형식이고 5분 창마다 하나, 본문 샘플 수 = 기대 샘플 수', () => {
    for (const batch of batches) {
      expect(batch.envelope.schema).toBe('om.ingest.v1');
      expect(batch.envelope.gateway).toBe(batch.gateway.code);
      expect(batch.envelope.series.reduce((s, x) => s + seriesLength(x), 0)).toBe(batch.expectedSamples + batch.expectedUnmappedSamples);
      expect(batch.resend || batch.backfill).toBe(false);
    }
    for (const code of ['SIM-A', 'SIM-B', 'SIM-C']) {
      const seqs = batches.filter((b) => b.siteCode === code).map((b) => b.envelope.seq);
      expect(seqs).toHaveLength(288);
      seqs.slice(1).forEach((seq, i) => expect(seq).toBeGreaterThan(seqs[i] ?? Infinity));
    }
    expect(new Set(batches.map((b) => b.envelope.batch_id)).size).toBe(batches.length);
  });

  it('미매핑 예정 태그는 SIM-B 봉투에만 실린다', () => {
    const sources = (code: string) => new Set(batches.filter((b) => b.siteCode === code).flatMap((b) => b.envelope.series.map((s) => s.src)));

    expect(sources('SIM-B').has('ELZ1/DRYER/DEWPOINT')).toBe(true);
    expect(sources('SIM-B').has('COMP1/VIB_RMS')).toBe(true);
    expect(sources('SIM-C').has('COMP1/VIB_RMS')).toBe(false);
  });
});

describe('simulate — 결정성', () => {
  it('같은 옵션이면 같은 봉투(같은 batch_id), 시드가 다르면 다른 봉투', async () => {
    const options: SimulateOptions = { siteCodes: ['SIM-B'], from: FROM, to: FROM + 3 * MS_PER_HOUR, seed: 7 };
    const a = await collect(options);
    const b = await collect(options);
    const c = await collect({ ...options, seed: 8 });

    expect(JSON.stringify(b.map((x) => x.envelope))).toBe(JSON.stringify(a.map((x) => x.envelope)));
    expect(c.map((x) => x.envelope.batch_id)).not.toEqual(a.map((x) => x.envelope.batch_id));
  });

  it('잘못된 옵션은 첫 반복에서 오류', async () => {
    await expect(collect({ siteCodes: ['SIM-Z'], ...ONE_DAY, seed: 1 })).rejects.toThrow('알 수 없는 가상 사이트');
    await expect(collect({ siteCodes: ['SIM-A'], from: FROM, to: FROM, seed: 1 })).rejects.toThrow('to는 from보다');
    await expect(collect({ siteCodes: ['SIM-A'], ...ONE_DAY, seed: 1, stepS: 7 })).rejects.toThrow('stepS');
  });
});

describe('simulate — 데이터 품질 시나리오', () => {
  it('dq.duplicate_batches: 같은 본문을 다시 보내고 기대 샘플은 0, 전체 기대치는 그대로', async () => {
    const batches = await collect({ siteCodes: ['SIM-B'], ...ONE_DAY, seed: 42, scenarios: [{ kind: 'dq.duplicate_batches', site: 'SIM-B', ratio: 0.3 }] });
    const resends = batches.filter((b) => b.resend);

    expect(resends.length / (batches.length - resends.length)).toBeGreaterThan(0.2);
    expect(resends.length / (batches.length - resends.length)).toBeLessThan(0.4);
    for (const resend of resends) {
      const original = batches[batches.indexOf(resend) - 1];
      expect(resend.envelope).toBe(original?.envelope);
      expect(resend.expectedSamples).toBe(0);
    }
    expect(sum(batches, (b) => b.expectedSamples)).toBe(dailyMappedSamples('SIM-B'));
  });

  it('dq.gateway_outage: 단절 중엔 보내지 않고, 끝나면 역순 백필 — 전체 기대치는 그대로', async () => {
    const outageStart = FROM + 2 * MS_PER_HOUR;
    const outageEnd = outageStart + 6 * MS_PER_HOUR;
    const batches = await collect({ siteCodes: ['SIM-A'], ...ONE_DAY, seed: 42, scenarios: [{ kind: 'dq.gateway_outage', site: 'SIM-A', start: outageStart, durationS: 6 * 3_600 }] });
    const backfill = batches.filter((b) => b.backfill);
    const seqs = backfill.map((b) => b.envelope.seq);

    expect(batches.some((b) => b.sentAtMs >= outageStart && b.sentAtMs < outageEnd)).toBe(false);
    expect(backfill).toHaveLength(72);
    seqs.slice(1).forEach((seq, i) => expect(seq).toBeLessThan(seqs[i] ?? -Infinity));
    backfill.forEach((b) => expect(b.sentAtMs).toBeGreaterThanOrEqual(outageEnd));
    expect(sum(batches, (b) => b.expectedSamples)).toBe(dailyMappedSamples('SIM-A'));
  });

  it('dq.clock_skew +200초: 모든 시각이 200초 밀리고 NTP 미동기, 서버 허용치(5분) 안이라 기대치는 그대로', async () => {
    const batches = await collect({ siteCodes: ['SIM-C'], from: FROM, to: FROM + 6 * MS_PER_HOUR, seed: 42, scenarios: [{ kind: 'dq.clock_skew', site: 'SIM-C', skewS: 200 }] });
    const allTs = batches.flatMap((b) => b.envelope.series.flatMap(timestamps));

    expect(allTs.every((ts) => (ts - FROM) % 60_000 === 20_000)).toBe(true);
    expect(batches.every((b) => b.envelope.clock.ntp_synced === false)).toBe(true);
    expect(batches.every((b) => Date.parse(b.envelope.sent_at) - b.sentAtMs === 200_000)).toBe(true);
    expect(sum(batches, (b) => b.expectedSamples)).toBe(dailyMappedSamples('SIM-C') / 4);
  });

  it('시계가 5분 넘게 빠르면 실시간 재생 기준 미래 샘플은 기대치에서 빠지고, 과거 적재(serverNowMs)면 모두 들어간다', async () => {
    const options: SimulateOptions = { siteCodes: ['SIM-A'], from: FROM, to: FROM + 2 * MS_PER_HOUR, seed: 42, scenarios: [{ kind: 'dq.clock_skew', site: 'SIM-A', skewS: 600 }] };
    const live = await collect(options);
    const backfill = await collect({ ...options, serverNowMs: Date.parse('2030-01-01T00:00:00Z') });
    const theoretical = dailyMappedSamples('SIM-A') / 12;

    expect(sum(live, (b) => b.expectedSamples)).toBeLessThan(theoretical);
    expect(sum(backfill, (b) => b.expectedSamples)).toBe(theoretical);
  });

  it('safety.h2_leak_alarm: critical 경보 이벤트가 봉투에 실린다', async () => {
    const at = FROM + 14 * MS_PER_HOUR;
    const batches = await collect({ siteCodes: ['SIM-B'], from: at - MS_PER_HOUR, to: at + MS_PER_HOUR, seed: 42, scenarios: [{ kind: 'safety.h2_leak_alarm', site: 'SIM-B', at }] });
    const alarms = batches.flatMap((b) => b.envelope.events).filter((e) => e.code === 'H2_LEAK_L1');

    expect(alarms).toEqual([{ src: 'GD3/ALARM', ts: at, code: 'H2_LEAK_L1', severity: 'critical', text: expect.any(String) }]);
  });
});
