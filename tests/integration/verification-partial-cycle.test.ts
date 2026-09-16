// 조치 효과 검증 확장 (hysol_test): 만충 앵커가 없는 부분 사이클 사이트에서도 용량 회복 조치를 검증한다.
// 충전 세션 방식(앵커·CC·SOC 변화)은 표본이 0이고 휴지 앵커 방식만 표본을 준다 — 전·후 같은 방식으로만 비교한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnalysis, type AnalysisRequest } from '@/lib/analysis/run';
import { registerMaintenanceAction } from '@/lib/analysis/transitions';
import { DAY_MS } from '../support/analysis-fixture';
import { dropAnalysisFixture } from '../support/analysis-fixture';
import { createEssPartialFixture, ESS_PARTIAL_BASE_MS, ESS_PARTIAL_SITE, RATED_CAPACITY_AH, type EssPartialFixture } from '../support/ess-partial-fixture';
import { createTestDb } from '../support/ingest-fixture';

const DAYS = 22;
const STEP_DAY = 11;
const BEFORE_AH = 380;
const AFTER_AH = 400;
const ADMIN = 'admin@hysol.local';
const at = (day: number): Date => new Date(ESS_PARTIAL_BASE_MS + day * DAY_MS);

interface Stats {
  readonly method: string;
  readonly n: number;
  readonly bins: readonly { readonly key: string; readonly n: number; readonly median: number }[];
}

describe('부분 사이클 사이트의 용량 조치 효과 검증 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: EssPartialFixture;
  const request = (to: number): AnalysisRequest => ({ siteIds: [fixture.siteId], from: at(0), to: at(to), requestedBy: ADMIN });

  beforeAll(async () => {
    fixture = await createEssPartialFixture(db, { days: DAYS, stepDay: STEP_DAY, beforeAh: BEFORE_AH, afterAh: AFTER_AH });
  }, 180_000);

  afterAll(async () => {
    await dropAnalysisFixture(db, ESS_PARTIAL_SITE);
    await db.destroy();
  });

  it('충전 세션 용량은 전부 비고 휴지·충방전 에피소드만 쌓인다', async () => {
    const result = await runAnalysis(db, request(DAYS), { now: () => at(DAYS) });
    expect(result.status).toBe('succeeded');
    const episodes = await db.selectFrom('om.episode').select(['kind', 'features']).where('asset_id', '=', fixture.rackId).where('valid', '=', true).execute();
    const charges = episodes.filter((e) => e.kind === 'ess.charge');
    expect(charges.length).toBeGreaterThanOrEqual(DAYS - 2);
    expect(episodes.filter((e) => e.kind === 'ess.rest').length).toBeGreaterThanOrEqual(DAYS);
    expect(episodes.filter((e) => e.kind === 'ess.discharge').length).toBeGreaterThanOrEqual(DAYS - 2);
    const capacityFields = charges.map((e) => e.features as Record<string, number | null>).map((f) => [f.capacity_ah_anchored, f.capacity_ah_cc, f.capacity_ah_soc]);
    expect(capacityFields.every((values) => values.every((v) => v === null))).toBe(true);
  }, 180_000);

  it('휴지 앵커 방식으로 전·후를 비교해 improved, 쓴 방식을 before_stats·after_stats에 남긴다', async () => {
    const effect = { metric: 'ess.capacity_ah', direction: 'increase' as const, min_delta: 5, stabilization_days: 1, window_days: 5 };
    const action = await registerMaintenanceAction(db, {
      siteId: fixture.siteId,
      assetId: fixture.rackId,
      findingId: null,
      actionType: '랙 교체',
      performedAt: at(STEP_DAY),
      expectedEffect: effect,
      source: 'manual',
      actor: ADMIN,
    });

    const result = await runAnalysis(db, request(DAYS), { now: () => at(DAYS) });
    expect(result.stats.sites[0]?.verification).toMatchObject({ checked: 1, verdicts: { improved: 1 } });
    const verification = await db.selectFrom('om.action_verification').selectAll().where('action_id', '=', action.actionId).executeTakeFirstOrThrow();
    expect(verification.verdict).toBe('improved');
    expect(Number(verification.effect)).toBeCloseTo(AFTER_AH - BEFORE_AH, 0);
    expect(Number(verification.ci_low)).toBeGreaterThan(0);

    const beforeStats = verification.before_stats as unknown as Stats & { readonly metric: string; readonly unit: string };
    const afterStats = verification.after_stats as unknown as Stats;
    expect(beforeStats).toMatchObject({ method: 'rest_anchored', metric: 'ess.capacity_ah', unit: 'Ah' });
    expect(afterStats.method).toBe('rest_anchored');
    // 휴지 앵커 쌍 bin은 방향(충전·방전) × 셀 온도다. 양쪽 모두 두 bin이 맞춰진다
    expect(beforeStats.bins.map((b) => b.key).sort()).toEqual(['chg|25', 'dis|25']);
    expect(afterStats.bins.map((b) => b.key).sort()).toEqual(['chg|25', 'dis|25']);
    for (const bin of beforeStats.bins) expect(bin.median).toBeCloseTo(BEFORE_AH, -1);
    for (const bin of afterStats.bins) expect(bin.median).toBeCloseTo(AFTER_AH, -1);
    // 랙 명판 정격이 방식 판단의 상한·하한이다 (정격의 50~150% 밖 추정은 버린다)
    expect(beforeStats.bins.every((b) => b.median > RATED_CAPACITY_AH * 0.5 && b.median < RATED_CAPACITY_AH * 1.5)).toBe(true);
  }, 180_000);
});
