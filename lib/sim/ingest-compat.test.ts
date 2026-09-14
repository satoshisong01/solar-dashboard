// 시뮬레이터 봉투가 lib/ingest 수집 규칙(zod 스키마·정규화)을 그대로 통과하고, 기대 샘플 수가 서버 계산과 같은지 확인한다.
import { beforeAll, describe, expect, it } from 'vitest';
import { METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { SIM_SITES } from '@/db/seed/sites';
import { parseEnvelope } from '@/lib/ingest/envelope';
import { normalizeSamples, type PointMapping } from '@/lib/ingest/normalize';
import { QUALITY } from '@/lib/ingest/quality';
import { simulate, type SimulatedBatch } from './index';
import { MS_PER_HOUR } from './math';
import type { Scenario } from './scenarios';

const FROM = Date.parse('2026-08-20T06:00:00+09:00');
const TO = FROM + 6 * MS_PER_HOUR;
const SKEW_START = FROM + 2 * MS_PER_HOUR;
const SKEW_END = FROM + 4 * MS_PER_HOUR;

const SCENARIOS: readonly Scenario[] = [
  { kind: 'dq.duplicate_batches', site: 'SIM-A', ratio: 0.5 },
  { kind: 'dq.clock_skew', site: 'SIM-A', skewS: 200, start: SKEW_START, durationS: 2 * 3_600 },
  { kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA', start: FROM, durationS: 3_600 },
  { kind: 'dq.gateway_outage', site: 'SIM-B', start: FROM + MS_PER_HOUR, durationS: 3_600 },
  { kind: 'dq.spike', site: 'SIM-B', sourceKey: 'H2BANK1/TANK1/P', perDay: 50 },
  { kind: 'safety.h2_leak_alarm', site: 'SIM-B', at: FROM + 3.5 * MS_PER_HOUR },
];

/** 사이트 시드 포인트로 서버와 같은 매핑을 만든다 (포인트 id는 사이트마다 겹치지 않게 부여). */
function mappingsBySite(): ReadonlyMap<string, ReadonlyMap<string, PointMapping>> {
  let nextId = 1;
  return new Map(
    SIM_SITES.map((site) => {
      const entries = site.assets.flatMap((asset) =>
        asset.points.map((point): [string, PointMapping] => {
          const metric = METRIC_DEF_BY_KEY.get(point.metricKey);
          const mapping = { pointId: nextId, scale: point.scale, valueOffset: point.valueOffset, hardMin: metric?.hardMin ?? null, hardMax: metric?.hardMax ?? null };
          nextId += 1;
          return [point.sourceKey, mapping];
        }),
      );
      return [site.code, new Map(entries)];
    }),
  );
}

describe('시뮬레이터 봉투 ↔ lib/ingest 수집 규칙', () => {
  const batches: SimulatedBatch[] = [];
  const mappings = mappingsBySite();

  beforeAll(async () => {
    for await (const batch of simulate({ siteCodes: ['SIM-A', 'SIM-B'], from: FROM, to: TO, seed: 42, scenarios: SCENARIOS })) batches.push(batch);
  }, 60_000);

  const normalized = (batch: SimulatedBatch) => {
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(batch.envelope)));
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    const pointsBySource = mappings.get(batch.siteCode) ?? new Map<string, PointMapping>();
    // 실시간 재생: 서버는 실제 전송 시각에 받는다
    return normalizeSamples(parsed.envelope, { pointsBySource, receivedAtMs: batch.sentAtMs });
  };

  it('모든 봉투(재전송 포함)가 om.ingest.v1 zod 스키마를 통과한다', () => {
    expect(batches.some((b) => b.resend)).toBe(true);
    for (const batch of batches) {
      const parsed = parseEnvelope(JSON.parse(JSON.stringify(batch.envelope)));
      expect(parsed.ok ? [] : parsed.issues, `${batch.siteCode} seq ${batch.envelope.seq}`).toEqual([]);
    }
  });

  it('배치별 expectedSamples·expectedUnmappedSamples가 서버 정규화 결과와 같고 거부·결측이 없다', () => {
    for (const batch of batches.filter((b) => !b.resend)) {
      const { stats } = normalized(batch);
      expect(stats, `${batch.siteCode} seq ${batch.envelope.seq}`).toMatchObject({
        candidates: batch.expectedSamples,
        unmapped: batch.expectedUnmappedSamples,
        rejected: 0,
        missing: 0,
      });
    }
  });

  it('시계 오차 구간 경계에서도 (포인트, 시각)이 겹치지 않아 기대치 합 = 고유 샘플 수', () => {
    const originals = batches.filter((b) => !b.resend);
    const keys = new Set(originals.flatMap((b) => normalized(b).samples.map((s) => `${s.pointId}:${s.tsMs}`)));

    expect(keys.size).toBe(originals.reduce((sum, b) => sum + b.expectedSamples, 0));
  });

  it('시계 오차는 구간 안에서 보낸 SIM-A 배치에만 적용되고, 그 샘플만 CLOCK_SUSPECT가 된다', () => {
    const originals = batches.filter((b) => !b.resend);
    const skewed = originals.filter((b) => !b.envelope.clock.ntp_synced);

    expect(skewed.length).toBeGreaterThan(0);
    for (const batch of originals) {
      const inWindow = batch.siteCode === 'SIM-A' && batch.sentAtMs >= SKEW_START && batch.sentAtMs < SKEW_END;
      expect(batch.envelope.clock.ntp_synced, `${batch.siteCode} ${new Date(batch.sentAtMs).toISOString()}`).toBe(!inWindow);
      expect(Date.parse(batch.envelope.sent_at) - batch.sentAtMs).toBe(inWindow ? 200_000 : 0);
      const suspect = normalized(batch).samples.filter((s) => (s.quality & QUALITY.CLOCK_SUSPECT) !== 0).length;
      expect(suspect).toBe(inWindow ? batch.expectedSamples : 0);
    }
  });

  it('누출 경보는 critical 안전 이벤트로 실린다', () => {
    const alarms = batches.filter((b) => !b.resend).flatMap((b) => b.envelope.events).filter((e) => e.code === 'H2_LEAK_L1');

    expect(alarms).toEqual([expect.objectContaining({ severity: 'critical', src: 'GD3/ALARM' })]);
  });
});
