// 조치 효과 검증 (설계 §3.1 조치·검증): 후 창(안정화 뒤 window_days일)이 분석 기간 안에서 다 채워진 정비 조치마다
// matched_before_after@1로 전후를 비교해 om.action_verification에 upsert하고, 개선이면 연결한 발견사항을 system이 verified로 옮긴다.
import { sql, type Kysely } from 'kysely';
import { beforeAfter, VERIFICATION_METHOD, VERIFICATION_METRICS, type Verdict } from '@/lib/analytics/verification/before-after';
import type { PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { MS_PER_DAY } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import { deriveRng } from '@/lib/sim/rng';
import { expectedEffectSchema, verifyFindingBySystem } from './transitions';

export const DEFAULT_VERIFICATION_WINDOW_DAYS = 30;

export interface VerificationStats {
  readonly checked: number;
  readonly pending: number;
  readonly invalidEffect: number;
  readonly verdicts: Readonly<Record<Verdict, number>>;
  readonly verifiedFindings: number;
}

const EMPTY_VERDICTS: Readonly<Record<Verdict, number>> = { improved: 0, no_change: 0, worse: 0, insufficient_data: 0 };
const iso = (ms: number): string => new Date(ms).toISOString();
const range = (start: number, end: number): string => `[${iso(start)},${iso(end)})`;

export interface VerifyActionsInput {
  readonly runId: string;
  readonly siteId: number;
  readonly assetIds: ReadonlySet<number> | null;
  /** 분석 기간 끝 (후 창이 이 시각까지 채워져야 검증한다) */
  readonly until: number;
  readonly episodes: readonly StoredEpisode[];
  /** 사이트 설비 (명판 capacity_ah → 용량 지표 휴지 앵커 방식) */
  readonly assets: readonly PipelineAsset[];
  readonly seed: number;
}

/** 명판 정격 용량 [Ah]. 없거나 0 이하면 null (휴지 앵커 방식을 쓰지 않는다) */
function ratedCapacityAh(assets: readonly PipelineAsset[], assetId: number): number | null {
  const raw = assets.find((a) => a.id === assetId)?.nameplate.capacity_ah;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function verifyActions(db: Kysely<DB>, input: VerifyActionsInput): Promise<VerificationStats> {
  const actions = await db
    .selectFrom('om.maintenance_action')
    .select(['id', 'asset_id', 'finding_id', 'action_type', 'expected_effect', sql<number>`(extract(epoch FROM performed_at) * 1000)::float8`.as('performed_ms')])
    .where('site_id', '=', input.siteId)
    .where('expected_effect', 'is not', null)
    .where('performed_at', '<', new Date(input.until))
    .orderBy('id')
    .execute();
  let stats: VerificationStats = { checked: 0, pending: 0, invalidEffect: 0, verdicts: EMPTY_VERDICTS, verifiedFindings: 0 };
  for (const action of actions) {
    if (input.assetIds && !input.assetIds.has(action.asset_id)) continue;
    const parsed = expectedEffectSchema.safeParse(action.expected_effect);
    if (!parsed.success) {
      stats = { ...stats, invalidEffect: stats.invalidEffect + 1 };
      continue;
    }
    const effect = parsed.data;
    const windowMs = (effect.window_days ?? DEFAULT_VERIFICATION_WINDOW_DAYS) * MS_PER_DAY;
    const before = { start: action.performed_ms - windowMs, end: action.performed_ms };
    const after = { start: action.performed_ms + effect.stabilization_days * MS_PER_DAY, end: action.performed_ms + effect.stabilization_days * MS_PER_DAY + windowMs };
    if (after.end > input.until) {
      stats = { ...stats, pending: stats.pending + 1 };
      continue;
    }
    const result = beforeAfter({
      assetId: action.asset_id,
      metric: effect.metric,
      direction: effect.direction,
      minDelta: effect.min_delta,
      before,
      after,
      episodes: input.episodes,
      ratedCapacityAh: ratedCapacityAh(input.assets, action.asset_id),
      rng: deriveRng(input.seed, 'verify', action.id),
    });
    const verified = await db.transaction().execute(async (trx) => {
      const values = {
        before_window: range(before.start, before.end),
        after_window: range(after.start, after.end),
        before_stats: JSON.stringify(result.beforeStats),
        after_stats: JSON.stringify(result.afterStats),
        effect: result.effect,
        ci_low: result.ciLow,
        ci_high: result.ciHigh,
        verdict: result.verdict,
        computed_at: new Date(),
        run_id: input.runId,
      };
      await trx
        .insertInto('om.action_verification')
        .values({ action_id: action.id, method: VERIFICATION_METHOD, ...values })
        .onConflict((oc) => oc.columns(['action_id', 'method']).doUpdateSet(values))
        .execute();
      if (result.verdict !== 'improved' || action.finding_id === null) return false;
      const label = VERIFICATION_METRICS[effect.metric]?.label ?? effect.metric;
      return (await verifyFindingBySystem(trx, action.finding_id, `조치 효과 확인(${action.action_type}): ${label} ${(result.effect ?? 0) >= 0 ? '+' : ''}${(result.effect ?? 0).toPrecision(3)}`)) !== null;
    });
    stats = { ...stats, checked: stats.checked + 1, verdicts: { ...stats.verdicts, [result.verdict]: stats.verdicts[result.verdict] + 1 }, verifiedFindings: stats.verifiedFindings + (verified ? 1 : 0) };
  }
  return stats;
}
