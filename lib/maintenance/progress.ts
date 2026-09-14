// 조치 효과 검증 진행 상태 (순수): 기대 효과 없음 · 안정화 중 · after 창 수집 중 · 창 채워짐(분석 실행 필요) · 검증됨.
// 창 규칙은 lib/analysis/verification.ts와 같다: 전 창 = [수행 − window, 수행), 후 창 = [수행 + 안정화, 수행 + 안정화 + window).
import { asNumber, asRecord, asString } from '@/lib/desk/json-read';
import { verdictLabel } from '@/lib/desk/labels';

/** lib/analysis/verification.ts DEFAULT_VERIFICATION_WINDOW_DAYS와 같다 */
export const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export type ProgressState = 'untracked' | 'stabilizing' | 'collecting' | 'ready' | 'verified';

export interface ActionProgress {
  readonly state: ProgressState;
  /** '안정화 3/7일' · 'after 창 12/30일' · '창 채워짐 · 분석 실행 필요' · '개선 확인' */
  readonly label: string;
  readonly verdict: string | null;
  readonly afterStart: number | null;
  readonly afterEnd: number | null;
  /** 0~1 (안정화+후 창 전체 대비 경과) */
  readonly fraction: number | null;
}

export interface ParsedExpectedEffect {
  readonly metric: string;
  readonly direction: 'increase' | 'decrease';
  readonly minDelta: number;
  readonly stabilizationDays: number;
  readonly windowDays: number;
}

export function parseExpectedEffect(raw: unknown): ParsedExpectedEffect | null {
  const e = asRecord(raw);
  const metric = asString(e.metric);
  const direction = asString(e.direction);
  const minDelta = asNumber(e.min_delta);
  const stabilizationDays = asNumber(e.stabilization_days);
  if (metric === null || (direction !== 'increase' && direction !== 'decrease') || minDelta === null || stabilizationDays === null) return null;
  return { metric, direction, minDelta, stabilizationDays, windowDays: asNumber(e.window_days) ?? DEFAULT_WINDOW_DAYS };
}

export function actionProgress(input: { readonly performedAt: number; readonly expectedEffect: unknown; readonly verdict: string | null }, nowMs: number): ActionProgress {
  const effect = parseExpectedEffect(input.expectedEffect);
  if (input.verdict !== null) {
    const windows = effect ? { afterStart: input.performedAt + effect.stabilizationDays * DAY_MS, afterEnd: input.performedAt + (effect.stabilizationDays + effect.windowDays) * DAY_MS } : { afterStart: null, afterEnd: null };
    return { state: 'verified', label: verdictLabel(input.verdict), verdict: input.verdict, ...windows, fraction: 1 };
  }
  if (!effect) return { state: 'untracked', label: '검증 안 함 (기대 효과 없음)', verdict: null, afterStart: null, afterEnd: null, fraction: null };
  const afterStart = input.performedAt + effect.stabilizationDays * DAY_MS;
  const afterEnd = afterStart + effect.windowDays * DAY_MS;
  const fraction = Math.min(1, Math.max(0, (nowMs - input.performedAt) / (afterEnd - input.performedAt)));
  const base = { verdict: null, afterStart, afterEnd, fraction };
  if (nowMs < input.performedAt) return { ...base, state: 'stabilizing', label: `수행 예정 · 안정화 0/${effect.stabilizationDays}일` };
  if (nowMs < afterStart) return { ...base, state: 'stabilizing', label: `안정화 ${Math.floor((nowMs - input.performedAt) / DAY_MS)}/${effect.stabilizationDays}일` };
  if (nowMs < afterEnd) return { ...base, state: 'collecting', label: `after 창 ${Math.floor((nowMs - afterStart) / DAY_MS)}/${effect.windowDays}일` };
  return { ...base, state: 'ready', label: '창 채워짐 · 분석 실행 필요' };
}
