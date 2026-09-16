// LLM 제공자 인터페이스와 폴백 사유 (순수 타입 모듈). 설계 §5.4의 연결 지점.
// 원칙: 판정과 수치는 분석 엔진이 내고, 제공자는 이미 만들어진 문장을 다시 쓰기만 한다.
// 제공자는 실패를 던지지 않고 사유가 붙은 결과로 돌려준다 — 화면은 언제나 틀 문장으로 이어져야 한다.

/** 한 번의 호출. 원시 시계열·계정 정보·비밀값은 담지 않는다 (lib/llm/prompt.ts가 만든다) */
export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/**
 * 틀 문장으로 되돌아간 사유.
 *   no_key/disabled  키가 없거나 AI 설명을 꺼 둠 (호출하지 않음)
 *   no_evidence      근거 스냅샷이 없어 만들 문장이 없음
 *   timeout          제한 시간 안에 응답 없음
 *   rate_limited     429  · server_error 5xx (둘 다 즉시 폴백)
 *   transport_error  네트워크 오류 (한 번 다시 시도한 뒤에도 실패)
 *   bad_response     응답을 읽을 수 없음 (빈 본문·JSON 아님·중단된 생성)
 *   rejected         생성은 됐지만 검증에 걸림 (숫자 조작·방향 뒤집기·금지 표현 등)
 */
export type LlmFailureReason = 'no_key' | 'disabled' | 'no_evidence' | 'timeout' | 'rate_limited' | 'server_error' | 'transport_error' | 'bad_response' | 'rejected';

export type LlmOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: LlmFailureReason; readonly detail: string };

export interface LlmProvider {
  /** 제공자 이름 ('gemini') */
  readonly id: string;
  /** 모델 id (om.finding_explanation.model에 그대로 남는다) */
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmOutcome>;
}

/** 쉬운 말 요약 4줄의 키 (lib/desk/plain의 PlainSummary와 같다) */
export const PLAIN_LINE_KEYS = ['what', 'basis', 'outlook', 'nextStep'] as const;
export type PlainLineKey = (typeof PLAIN_LINE_KEYS)[number];
export type PlainLines = Readonly<Partial<Record<PlainLineKey, string>>>;

export const failure = (reason: LlmFailureReason, detail: string): LlmOutcome => ({ ok: false, reason, detail });
