// 저장해 둔 문장을 다시 쓸 것인가, 한 번 더 불러 볼 것인가 (순수 모듈 — DB도 시계도 여기서 읽지 않는다).
//
// 틀 문장으로 되돌아간 사유는 두 갈래다.
//   일시적: 제공자 쪽 사정이라 잠시 뒤 같은 입력을 보내면 성공할 수 있다
//           timeout · rate_limited(429) · server_error(5xx) · transport_error(네트워크)
//   영구적: 같은 입력이면 다시 불러도 같다 — 사람이 설정이나 규칙을 고쳐야 바뀐다
//           no_key · disabled(부르지도 않는다) · no_evidence(보낼 근거가 없다)
//           bad_response · rejected(모델이 쓴 문장을 쓸 수 없다 — 프롬프트나 검증 규칙을 고쳐야 한다)
//
// 일시적 실패까지 저장해 두고 계속 쓰면, 한 번 끊긴 뒤로는 발견사항이 바뀌거나 관리자가 '다시 생성'을
// 누를 때까지 AI 문장이 영영 나오지 않는다. 그렇다고 저장하지 않으면 장애가 이어지는 동안 화면을 열 때마다
// 모델을 부르고 그때마다 응답을 기다린다. 그래서 저장은 하되 짧은 기간만 쓴다.
//
// 영구적 실패(특히 rejected)도 프롬프트나 검증 규칙을 고치면 결과가 달라진다. 그래서 프롬프트 버전이
// 저장할 때와 다르면 그 행은 없는 것으로 보고 한 번 더 부른다 — 버전을 올리는 것이 곧 캐시 무효화다.
import type { LlmFailureReason } from './types';

const TRANSIENT: ReadonlySet<LlmFailureReason> = new Set<LlmFailureReason>(['timeout', 'rate_limited', 'server_error', 'transport_error']);

export const isTransientFailure = (reason: LlmFailureReason | null): boolean => reason !== null && TRANSIENT.has(reason);

/** 일시적 실패로 저장된 틀 문장을 그대로 쓰는 기간. 지나면 다음 조회에서 한 번 더 부른다 */
export const TRANSIENT_RETRY_MS = 120_000;

/** '다시 생성' 버튼을 같은 사람이 같은 대상에 다시 누를 수 있기까지의 최소 간격 (연타 방지) */
export const REGENERATE_MIN_INTERVAL_MS = 10_000;

/** 저장된 행에서 이 판단에 필요한 것만 */
export interface StoredOutcome {
  readonly source: 'template' | 'llm';
  /** 틀 문장으로 되돌아간 사유 (채택했으면 null) */
  readonly reason: LlmFailureReason | null;
  /** 그때 쓴 프롬프트 버전 */
  readonly promptVersion: string;
  readonly createdAtMs: number;
}

/** 저장된 문장을 그대로 쓸 수 있는가. 프롬프트 버전이 바뀌었거나, 일시적 실패로 남은 틀 문장의 기간이 지났으면 버린다 */
export function canReuseStored(stored: StoredOutcome, nowMs: number, promptVersion: string): boolean {
  if (stored.promptVersion !== promptVersion) return false;
  if (stored.source === 'llm') return true;
  if (!isTransientFailure(stored.reason)) return true;
  return nowMs - stored.createdAtMs < TRANSIENT_RETRY_MS;
}
