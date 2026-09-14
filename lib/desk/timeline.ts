// 발견사항 활동 타임라인: 상태 전이 · 근거 스냅샷 추가 · 조치 기록 · 조치 효과 검증을 시간 역순으로 합친다. 순수 모듈.
import { statusLabel, SYSTEM_ACTOR, type FindingStatus } from '@/lib/analysis/transition-rules';
import { formatKstDate } from '@/lib/format';
import { formatSigned } from './effect';
import { verdictLabel } from './labels';

export interface TransitionItem {
  readonly id: string;
  readonly fromStatus: FindingStatus | null;
  readonly toStatus: FindingStatus;
  readonly actor: string;
  readonly note: string | null;
  readonly atMs: number;
}

export interface EvidenceItem {
  readonly id: string;
  readonly runId: string;
  readonly inputHash: string;
  readonly computedAtMs: number;
}

export interface ActionItem {
  readonly id: string;
  readonly actionType: string;
  readonly performedAtMs: number;
  readonly performedBy: string | null;
  readonly notes: string | null;
  readonly createdBy: string;
  readonly createdAtMs: number;
  /** 기대 효과 요약 문구 (없으면 null) */
  readonly expectedEffectText: string | null;
}

export interface VerificationItem {
  readonly id: string;
  readonly actionId: string;
  readonly verdict: string;
  readonly effect: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly unit: string | null;
  readonly computedAtMs: number;
}

export type TimelineKind = 'transition' | 'evidence' | 'action' | 'verification';

export interface TimelineEntry {
  readonly key: string;
  readonly kind: TimelineKind;
  readonly atMs: number;
  readonly title: string;
  readonly detail: string | null;
  readonly actor: string | null;
}

const KIND_ORDER: Readonly<Record<TimelineKind, number>> = { verification: 0, action: 1, transition: 2, evidence: 3 };

const actorLabel = (actor: string): string => (actor === SYSTEM_ACTOR ? '시스템' : actor);

function transitionEntry(t: TransitionItem): TimelineEntry {
  const title = t.fromStatus === null ? `발견사항 생성 (${statusLabel(t.toStatus)})` : `상태 ${statusLabel(t.fromStatus)} → ${statusLabel(t.toStatus)}`;
  return { key: `t${t.id}`, kind: 'transition', atMs: t.atMs, title, detail: t.note, actor: actorLabel(t.actor) };
}

function actionEntry(a: ActionItem, nowMs: number): TimelineEntry {
  const when = `${a.performedAtMs > nowMs ? '수행 예정' : '수행'} ${formatKstDate(a.performedAtMs)}${a.performedBy ? ` · ${a.performedBy}` : ''}`;
  const detail = [when, a.expectedEffectText, a.notes].filter((part): part is string => part !== null && part !== '').join(' · ');
  return { key: `a${a.id}`, kind: 'action', atMs: a.createdAtMs, title: `조치 기록: ${a.actionType}`, detail, actor: a.createdBy };
}

function verificationEntry(v: VerificationItem): TimelineEntry {
  const unit = v.unit ? ` ${v.unit}` : '';
  const effect = v.effect === null ? null : `효과 ${formatSigned(v.effect, 3)}${unit}${v.ciLow !== null && v.ciHigh !== null ? ` (95% CI ${formatSigned(v.ciLow, 3)} ~ ${formatSigned(v.ciHigh, 3)})` : ''}`;
  return { key: `v${v.id}`, kind: 'verification', atMs: v.computedAtMs, title: `조치 효과 검증: ${verdictLabel(v.verdict)}`, detail: effect, actor: '시스템' };
}

export function buildTimeline(
  input: Readonly<{ transitions: readonly TransitionItem[]; evidences: readonly EvidenceItem[]; actions: readonly ActionItem[]; verifications: readonly VerificationItem[] }>,
  nowMs: number,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...input.transitions.map(transitionEntry),
    ...input.evidences.map((e): TimelineEntry => ({ key: `e${e.id}`, kind: 'evidence', atMs: e.computedAtMs, title: '근거 스냅샷 추가', detail: `분석 실행 #${e.runId} · 입력 해시 ${e.inputHash.slice(0, 8)}`, actor: '시스템' })),
    ...input.actions.map((a) => actionEntry(a, nowMs)),
    ...input.verifications.map(verificationEntry),
  ];
  return entries.sort((a, b) => b.atMs - a.atMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
