// 탐지 결과 → om.finding upsert + finding_evidence append (설계 §5.2 분석 그룹).
//   dedup_key = 탐지기|설비(또는 site:<id>)|고장모드 (탐지 창 제외)
//   열린 건이 있으면 갱신: last_detected_at·detection_count·category·severity·confidence·effect·제목·요약·창, 조치 뒤 악화면 system이 reopened로
//   (category도 갱신한다: 누설처럼 심각도에 따라 안전·성능이 갈리는 탐지기는 DB CHECK(safety ⇒ severity ≥ 4)와 안전 발견사항 판정이 어긋나지 않게)
//   열린 건이 없으면: 억제 기간 안의 기각 건이면 건너뛰고, 아니면 새 finding (닫힌 이전 건은 previous_finding_id로 잇는다 = 재발)
//   근거는 탐지할 때마다 한 행씩 추가하고 latest_evidence_id가 가리킨다. 스냅샷에는 적용 설정 {scope, version, params_hash}를 함께 남긴다.
import type { Kysely, Transaction } from 'kysely';
import type { CandidateFinding } from '@/lib/analytics/detectors/types';
import type { ConfigRef, DetectorOutcome } from '@/lib/analytics/pipeline/types';
import type { DB } from '@/lib/db/types';
import { applyTransition } from './transitions';
import { SYSTEM_ACTOR } from './transition-rules';

export interface FindingPersistStats {
  readonly created: number;
  readonly updated: number;
  readonly suppressed: number;
  readonly recurrences: number;
  readonly worsened: number;
}

export const EMPTY_PERSIST_STATS: FindingPersistStats = Object.freeze({ created: 0, updated: 0, suppressed: 0, recurrences: 0, worsened: 0 });

export const dedupKeyOf = (siteId: number, finding: Pick<CandidateFinding, 'detectorId' | 'assetId' | 'failureMode'>): string =>
  `${finding.detectorId}|${finding.assetId ?? `site:${siteId}`}|${finding.failureMode}`;

type Outcome = 'created' | 'updated' | 'suppressed' | 'recurrence' | 'worsened';

interface PersistContext {
  readonly runId: string;
  readonly siteId: number;
  readonly now: Date;
  readonly configVersions: readonly string[];
  readonly config: ConfigRef;
}

async function appendEvidence(trx: Transaction<DB>, findingId: string, candidate: CandidateFinding, ctx: PersistContext): Promise<void> {
  const config = { scope: ctx.config.scope, version: ctx.config.version, params_hash: ctx.config.paramsHash };
  const snapshot = { ...candidate.evidence, detector: `${candidate.detectorId}@${candidate.detectorVersion}`, config_versions: [...ctx.configVersions], config };
  const evidence = await trx
    .insertInto('om.finding_evidence')
    .values({ finding_id: findingId, run_id: ctx.runId, computed_at: ctx.now, input_hash: candidate.inputHash, snapshot: JSON.stringify(snapshot) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('om.finding').set({ latest_evidence_id: evidence.id }).where('id', '=', findingId).execute();
}

const findingFields = (candidate: CandidateFinding) => ({
  detector_version: candidate.detectorVersion,
  category: candidate.category,
  severity: candidate.severity,
  confidence: candidate.confidence,
  title: candidate.title,
  summary: candidate.summary,
  effect: JSON.stringify(candidate.effect),
  window_start: new Date(candidate.windowStart),
  window_end: new Date(Math.max(candidate.windowStart, candidate.windowEnd)),
});

async function updateOpen(trx: Transaction<DB>, open: { id: string; status: string; severity: number; detection_count: number }, candidate: CandidateFinding, ctx: PersistContext): Promise<Outcome> {
  await trx
    .updateTable('om.finding')
    .set({ ...findingFields(candidate), last_detected_at: ctx.now, detection_count: open.detection_count + 1, updated_at: ctx.now })
    .where('id', '=', open.id)
    .execute();
  await appendEvidence(trx, open.id, candidate, ctx);
  if (candidate.severity <= open.severity) return 'updated';
  if (['triaged', 'in_report', 'action_taken'].includes(open.status)) {
    await applyTransition(trx, open.id, 'worsen', SYSTEM_ACTOR, { note: `심각도 악화 ${open.severity} → ${candidate.severity}` });
  }
  return 'worsened';
}

async function persistOne(db: Kysely<DB>, candidate: CandidateFinding, ctx: PersistContext): Promise<Outcome> {
  const dedupKey = dedupKeyOf(ctx.siteId, candidate);
  return db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom('om.finding')
      .select(['id', 'status', 'severity', 'detection_count'])
      .where('dedup_key', '=', dedupKey)
      .where('status', 'not in', ['verified', 'dismissed'])
      .forUpdate()
      .executeTakeFirst();
    if (open) return updateOpen(trx, open, candidate, ctx);

    const previous = await trx.selectFrom('om.finding').select(['id', 'status', 'suppressed_until']).where('dedup_key', '=', dedupKey).orderBy('id', 'desc').executeTakeFirst();
    if (previous?.status === 'dismissed' && previous.suppressed_until !== null && previous.suppressed_until > ctx.now) return 'suppressed';
    const created = await trx
      .insertInto('om.finding')
      .values({
        ...findingFields(candidate),
        site_id: ctx.siteId,
        asset_id: candidate.assetId,
        detector_id: candidate.detectorId,
        failure_mode: candidate.failureMode,
        dedup_key: dedupKey,
        status: 'new',
        first_detected_at: ctx.now,
        last_detected_at: ctx.now,
        previous_finding_id: previous?.id ?? null,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('om.finding_transition').values({ finding_id: created.id, from_status: null, to_status: 'new', actor: SYSTEM_ACTOR, note: `분석 실행 ${ctx.runId}`, at: ctx.now }).execute();
    await appendEvidence(trx, created.id, candidate, ctx);
    return previous ? 'recurrence' : 'created';
  });
}

/** 탐지 결과의 finding을 모두 저장한다. 결과별 개수를 돌려준다 (재발은 created에도 센다) */
export async function persistFindings(db: Kysely<DB>, input: { runId: string; siteId: number; outcomes: readonly DetectorOutcome[]; now: Date }): Promise<FindingPersistStats> {
  let stats = EMPTY_PERSIST_STATS;
  for (const outcome of input.outcomes) {
    for (const candidate of outcome.findings) {
      const result = await persistOne(db, candidate, { runId: input.runId, siteId: input.siteId, now: input.now, configVersions: outcome.configVersions, config: outcome.config });
      stats = {
        created: stats.created + (result === 'created' || result === 'recurrence' ? 1 : 0),
        updated: stats.updated + (result === 'updated' || result === 'worsened' ? 1 : 0),
        suppressed: stats.suppressed + (result === 'suppressed' ? 1 : 0),
        recurrences: stats.recurrences + (result === 'recurrence' ? 1 : 0),
        worsened: stats.worsened + (result === 'worsened' ? 1 : 0),
      };
    }
  }
  return stats;
}
