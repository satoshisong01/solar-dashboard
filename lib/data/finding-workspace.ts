import 'server-only';
import type { FailureMode, FindingCategory } from '@/lib/analytics/detectors/types';
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import { VERIFICATION_METRICS } from '@/lib/analytics/verification/before-after';
import { isFindingStatus, type FindingStatus } from '@/lib/analysis/transition-rules';
import { db } from '@/lib/db/kysely';
import { parseEffect, type EffectView } from '@/lib/desk/effect';
import { parseEvidence } from '@/lib/desk/evidence';
import type { EvidenceView } from '@/lib/desk/evidence-types';
import { asArray, asNumber, asRecord, asString } from '@/lib/desk/json-read';
import { isFindingCategory } from '@/lib/desk/labels';
import type { ActionItem, EvidenceItem, TransitionItem, VerificationItem } from '@/lib/desk/timeline';
import { formatNumber } from '@/lib/format';

export interface FindingAsset {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly classKey: string;
}

export interface FindingDetail {
  readonly id: string;
  readonly siteId: number;
  readonly siteCode: string;
  readonly siteName: string;
  readonly asset: FindingAsset | null;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly failureMode: FailureMode | null;
  readonly category: FindingCategory;
  readonly severity: number;
  readonly confidence: number;
  readonly status: FindingStatus;
  readonly title: string;
  readonly summary: string;
  readonly effect: EffectView;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly firstDetectedMs: number;
  readonly lastDetectedMs: number;
  readonly detectionCount: number;
  readonly previousFindingId: string | null;
  readonly dismissReason: string | null;
  readonly evidence: EvidenceView;
  readonly evidenceAtMs: number | null;
  readonly configVersions: readonly string[];
  readonly transitions: readonly TransitionItem[];
  readonly evidences: readonly EvidenceItem[];
  readonly actions: readonly ActionItem[];
  readonly verifications: readonly VerificationItem[];
}

const isFailureMode = (value: string): value is FailureMode => Object.hasOwn(PLAYBOOKS, value);

function expectedEffectText(raw: unknown): string | null {
  const e = asRecord(raw);
  const metric = asString(e.metric);
  if (metric === null) return null;
  const spec = VERIFICATION_METRICS[metric];
  const direction = asString(e.direction) === 'decrease' ? '감소' : '증가';
  const delta = asNumber(e.min_delta);
  const days = asNumber(e.stabilization_days);
  return `기대 효과: ${spec?.label ?? metric} ${delta === null ? '' : `${formatNumber(delta, 4)} ${spec?.unit ?? ''} 이상 `}${direction}${days === null ? '' : ` (안정화 ${days}일)`}`;
}

async function loadHistory(findingId: string) {
  const [transitions, evidences, actions] = await Promise.all([
    db.selectFrom('om.finding_transition').select(['id', 'from_status', 'to_status', 'actor', 'note', 'at']).where('finding_id', '=', findingId).orderBy('at').orderBy('id').execute(),
    db.selectFrom('om.finding_evidence').select(['id', 'run_id', 'input_hash', 'computed_at']).where('finding_id', '=', findingId).orderBy('computed_at').execute(),
    db.selectFrom('om.maintenance_action').select(['id', 'action_type', 'performed_at', 'performed_by', 'notes', 'created_by', 'created_at', 'expected_effect']).where('finding_id', '=', findingId).orderBy('created_at').execute(),
  ]);
  const verifications =
    actions.length === 0
      ? []
      : await db.selectFrom('om.action_verification').select(['id', 'action_id', 'verdict', 'effect', 'ci_low', 'ci_high', 'computed_at', 'before_stats']).where('action_id', 'in', actions.map((a) => a.id)).orderBy('computed_at').execute();
  return {
    transitions: transitions.flatMap((t): TransitionItem[] =>
      isFindingStatus(t.to_status) ? [{ id: t.id, fromStatus: t.from_status !== null && isFindingStatus(t.from_status) ? t.from_status : null, toStatus: t.to_status, actor: t.actor, note: t.note, atMs: t.at.getTime() }] : [],
    ),
    evidences: evidences.map((e): EvidenceItem => ({ id: e.id, runId: e.run_id, inputHash: e.input_hash, computedAtMs: e.computed_at.getTime() })),
    actions: actions.map((a): ActionItem => ({ id: a.id, actionType: a.action_type, performedAtMs: a.performed_at.getTime(), performedBy: a.performed_by, notes: a.notes, createdBy: a.created_by, createdAtMs: a.created_at.getTime(), expectedEffectText: expectedEffectText(a.expected_effect) })),
    verifications: verifications.map((v): VerificationItem => ({ id: v.id, actionId: v.action_id, verdict: v.verdict, effect: v.effect, ciLow: v.ci_low, ciHigh: v.ci_high, unit: asString(asRecord(v.before_stats).unit), computedAtMs: v.computed_at.getTime() })),
  };
}

/** 워크스페이스 한 화면 분량: 발견사항·설비·최신 근거·이력. 없으면 null */
export async function getFindingDetail(findingId: string): Promise<FindingDetail | null> {
  const row = await db
    .selectFrom('om.finding as f')
    .innerJoin('om.site as s', 's.id', 'f.site_id')
    .leftJoin('om.asset as a', 'a.id', 'f.asset_id')
    .leftJoin('om.finding_evidence as e', 'e.id', 'f.latest_evidence_id')
    .select(['f.id', 'f.site_id', 's.code as site_code', 's.name as site_name', 'f.asset_id', 'a.code as asset_code', 'a.name as asset_name', 'a.class_key'])
    .select(['f.detector_id', 'f.detector_version', 'f.failure_mode', 'f.category', 'f.severity', 'f.confidence', 'f.status', 'f.title', 'f.summary', 'f.effect'])
    .select(['f.window_start', 'f.window_end', 'f.first_detected_at', 'f.last_detected_at', 'f.detection_count', 'f.previous_finding_id', 'f.dismiss_reason', 'e.snapshot', 'e.computed_at as evidence_at'])
    .where('f.id', '=', findingId)
    .executeTakeFirst();
  if (!row || !isFindingStatus(row.status) || !isFindingCategory(row.category)) return null;
  const history = await loadHistory(row.id);
  const configVersions = asArray(asRecord(row.snapshot).config_versions).flatMap((v) => (typeof v === 'string' ? [v] : []));
  return {
    id: row.id,
    siteId: row.site_id,
    siteCode: row.site_code,
    siteName: row.site_name,
    asset: row.asset_id !== null && row.asset_code !== null && row.asset_name !== null && row.class_key !== null ? { id: row.asset_id, code: row.asset_code, name: row.asset_name, classKey: row.class_key } : null,
    detectorId: row.detector_id,
    detectorVersion: row.detector_version,
    failureMode: isFailureMode(row.failure_mode) ? row.failure_mode : null,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    status: row.status,
    title: row.title,
    summary: row.summary,
    effect: parseEffect(row.effect),
    windowStartMs: row.window_start.getTime(),
    windowEndMs: row.window_end.getTime(),
    firstDetectedMs: row.first_detected_at.getTime(),
    lastDetectedMs: row.last_detected_at.getTime(),
    detectionCount: row.detection_count,
    previousFindingId: row.previous_finding_id,
    dismissReason: row.dismiss_reason,
    evidence: parseEvidence(row.snapshot),
    evidenceAtMs: row.evidence_at ? row.evidence_at.getTime() : null,
    configVersions,
    ...history,
  };
}

/** 동종 랙 id → 설비 코드 (셀 불균형 동종 비교 표) */
export async function getAssetCodes(assetIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.selectFrom('om.asset').select(['id', 'code']).where('id', 'in', [...assetIds]).execute();
  return new Map(rows.map((r) => [r.id, r.code]));
}
