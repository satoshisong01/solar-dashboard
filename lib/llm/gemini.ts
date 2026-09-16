// Gemini REST 제공자 (서버 전용). 키가 없으면 만들지 않는다 — 앱은 그대로 동작하고 틀 문장만 쓴다.
// 재시도 방침: 네트워크 오류만 한 번 더 시도한다. 429·5xx는 같은 답이 올 가능성이 높고 화면을 늦추므로 즉시 폴백하고,
// 타임아웃도 다시 기다리면 화면이 두 배로 늦어지므로 재시도하지 않는다.
import 'server-only';
import { getServerEnv } from '@/lib/env';
import { asArray, asRecord, asString } from '@/lib/desk/json-read';
import { failure, type LlmOutcome, type LlmProvider, type LlmRequest } from './types';

/**
 * 기본 모델 id. 근거(2026-09-16 확인):
 *   https://ai.google.dev/gemini-api/docs/models — flash 계열 최신 정식(GA) 모델
 *   https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash — "generally available (GA)", thinkingLevel은 LOW·MEDIUM·HIGH만 (MINIMAL 불가)
 * GEMINI_MODEL 환경변수로 덮어쓸 수 있다 (더 싼 lite 계열로 바꾸는 등).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const LLM_TIMEOUT_MS = 20_000;
const TRANSPORT_RETRIES = 1;
/** 문장을 다시 쓰기만 하므로 추론은 가장 낮게 (MINIMAL은 3.8 flash가 받지 않는다) */
const THINKING_LEVEL = 'LOW';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 테스트용 주입 (실제 API를 부르지 않는다) */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

interface Config {
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
}

function requestBody(request: LlmRequest): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
    },
  });
}

/** candidates[0].content.parts[*].text. 생성이 STOP으로 끝나지 않았으면(길이 초과·차단) 읽지 않는다 */
function readText(payload: unknown): LlmOutcome {
  const candidate = asRecord(asArray(asRecord(payload).candidates)[0]);
  const finish = asString(candidate.finishReason);
  if (finish !== null && finish !== 'STOP') return failure('bad_response', `생성이 ${finish}(으)로 끝났습니다`);
  const text = asArray(asRecord(candidate.content).parts)
    .map((part) => asString(asRecord(part).text) ?? '')
    .join('')
    .trim();
  if (text === '') {
    const blocked = asString(asRecord(asRecord(payload).promptFeedback).blockReason);
    return failure('bad_response', blocked === null ? '본문이 비어 있습니다' : `요청이 차단됐습니다(${blocked})`);
  }
  return { ok: true, text };
}

/** 오류 문구에 키가 섞이지 않게 메시지만 쓴다 (키는 헤더로만 보낸다) */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '알 수 없는 오류');

async function callOnce(request: LlmRequest, config: Config): Promise<LlmOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await config.fetchImpl(`${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: requestBody(request),
      signal: controller.signal,
    });
    if (response.status === 429) return failure('rate_limited', 'HTTP 429');
    if (response.status >= 500) return failure('server_error', `HTTP ${response.status}`);
    if (!response.ok) return failure('bad_response', `HTTP ${response.status}`);
    return readText(await response.json());
  } catch (error) {
    if (controller.signal.aborted) return failure('timeout', `${config.timeoutMs}ms 안에 응답이 없습니다`);
    return failure('transport_error', messageOf(error));
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(request: LlmRequest, config: Config): Promise<LlmOutcome> {
  let last = await callOnce(request, config);
  for (let attempt = 0; attempt < TRANSPORT_RETRIES && !last.ok && last.reason === 'transport_error'; attempt += 1) {
    last = await callOnce(request, config);
  }
  return last;
}

export function createGeminiProvider(options: GeminiOptions): LlmProvider {
  const config: Config = {
    apiKey: options.apiKey,
    model: options.model,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
  };
  return { id: 'gemini', model: config.model, complete: (request) => callGemini(request, config) };
}

/** 환경변수로 제공자를 만든다. GEMINI_API_KEY가 없으면 null (호출하지 않고 틀 문장만 쓴다) */
export function getGeminiProvider(): LlmProvider | null {
  const env = getServerEnv();
  if (env.GEMINI_API_KEY === undefined) return null;
  return createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL });
}
