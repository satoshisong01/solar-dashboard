// 시뮬레이터 봉투를 게이트웨이처럼 gzip·HMAC 서명(lib/ingest/signature)해 POST /api/ingest/v1로 보낸다.
// sent_at은 실제 전송 시각으로 다시 찍는다: 서버는 sent_at과 수신 시각 차이로 CLOCK_SUSPECT를 판정하기 때문이다.
// 같은 봉투 객체(시뮬레이터의 중복 재전송)는 처음 만든 본문 바이트를 그대로 다시 보낸다 → 서버 200 duplicate.
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import * as z from 'zod';
import { signBatch } from '@/lib/ingest/signature';
import type { IngestEnvelope } from './envelope';
import type { SimulatedBatch } from './index';

export const INGEST_PATH = '/api/ingest/v1';
export const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_WAIT_MS = 30_000;
const NETWORK_BACKOFF_BASE_MS = 1_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

const gzipAsync = promisify(gzip);

export interface GatewayCredential {
  readonly keyId: string;
  readonly secret: string;
}

export type EmitBatch = Pick<SimulatedBatch, 'envelope' | 'sentAtMs'>;

/** 수집 API 200 응답의 카운트 (lib/ingest/store IngestCounts) */
export const countsSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  unmapped: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});
const successSchema = countsSchema.extend({ status: z.enum(['accepted', 'duplicate']) });
const errorSchema = z.object({ error: z.string(), message: z.string(), issues: z.array(z.string()).optional() });

export type IngestCountsBody = z.infer<typeof countsSchema>;

export type EmitResult =
  | { readonly kind: 'accepted' | 'duplicate'; readonly counts: IngestCountsBody; readonly attempts: number }
  | { readonly kind: 'conflict'; readonly attempts: number }
  | { readonly kind: 'failed'; readonly httpStatus: number | null; readonly error: string; readonly attempts: number };

export interface HttpEmitterOptions {
  readonly baseUrl: string;
  /** 게이트웨이 코드 → 키 ID·비밀값 */
  readonly credentials: ReadonlyMap<string, GatewayCredential>;
  readonly fetch?: typeof fetch;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

export interface HttpEmitter {
  emit(batch: EmitBatch): Promise<EmitResult>;
}

interface PreparedBody {
  readonly body: Uint8Array<ArrayBuffer>;
  /** 시뮬레이션 게이트웨이 시계 오차 (서명 시각에도 적용) */
  readonly skewMs: number;
}

/** 봉투의 sent_at을 nowMs 기준으로 다시 찍는다. 시뮬레이션 시계 오차(sent_at − sentAtMs)는 그대로 둔다. */
export function rebaseEnvelope(batch: EmitBatch, nowMs: number): { readonly envelope: IngestEnvelope; readonly skewMs: number } {
  const skewMs = Date.parse(batch.envelope.sent_at) - batch.sentAtMs;
  if (!Number.isFinite(skewMs)) throw new Error(`봉투 sent_at을 해석할 수 없습니다: ${batch.envelope.sent_at}`);
  return { envelope: { ...batch.envelope, sent_at: new Date(nowMs + skewMs).toISOString() }, skewMs };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, MAX_RETRY_WAIT_MS) : DEFAULT_RETRY_AFTER_MS;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type AttemptOutcome = { readonly done: EmitResult } | { readonly retryInMs: number; readonly lastError: Omit<Extract<EmitResult, { kind: 'failed' }>, 'attempts'> };

async function interpret(response: Response, attempt: number): Promise<AttemptOutcome> {
  const payload = await readJson(response);
  if (response.status === 200) {
    const parsed = successSchema.safeParse(payload);
    if (parsed.success) {
      const { status, ...counts } = parsed.data;
      return { done: { kind: status, counts, attempts: attempt } };
    }
    return { done: { kind: 'failed', httpStatus: 200, error: '200 응답 본문이 수집 응답 형식이 아닙니다', attempts: attempt } };
  }
  if (response.status === 409) return { done: { kind: 'conflict', attempts: attempt } };

  const parsedError = errorSchema.safeParse(payload);
  const detail = parsedError.success
    ? `${parsedError.data.error}: ${parsedError.data.message}${parsedError.data.issues ? ` (${parsedError.data.issues.slice(0, 3).join('; ')})` : ''}`
    : '알 수 없는 오류 응답';
  const failure = { kind: 'failed', httpStatus: response.status, error: `${response.status} ${detail}` } as const;
  if (RETRYABLE_STATUSES.has(response.status)) return { retryInMs: retryAfterMs(response), lastError: failure };
  return { done: { ...failure, attempts: attempt } };
}

export function createHttpEmitter(options: HttpEmitterOptions): HttpEmitter {
  const fetchFn = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = new URL(INGEST_PATH, options.baseUrl).toString();
  const prepared = new WeakMap<IngestEnvelope, Promise<PreparedBody>>();

  const prepare = (batch: EmitBatch): Promise<PreparedBody> => {
    const cached = prepared.get(batch.envelope);
    if (cached) return cached;
    const { envelope, skewMs } = rebaseEnvelope(batch, nowMs());
    const body = gzipAsync(Buffer.from(JSON.stringify(envelope), 'utf8')).then((bytes) => ({ body: new Uint8Array(bytes), skewMs }));
    prepared.set(batch.envelope, body);
    return body;
  };

  const attemptOnce = async (credential: GatewayCredential, { body, skewMs }: PreparedBody, attempt: number): Promise<AttemptOutcome> => {
    const signature = signBatch(credential.keyId, credential.secret, Math.floor((nowMs() + skewMs) / 1_000), body);
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...signature },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await interpret(response, attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitMs = Math.min(NETWORK_BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
      return { retryInMs: waitMs, lastError: { kind: 'failed', httpStatus: null, error: `전송 실패: ${message}` } };
    }
  };

  return {
    async emit(batch) {
      const credential = options.credentials.get(batch.envelope.gateway);
      if (!credential) return { kind: 'failed', httpStatus: null, error: `게이트웨이 ${batch.envelope.gateway}의 키 정보가 없습니다`, attempts: 0 };
      const body = await prepare(batch);

      for (let attempt = 1; ; attempt += 1) {
        const outcome = await attemptOnce(credential, body, attempt);
        if ('done' in outcome) return outcome.done;
        if (attempt >= maxAttempts) return { ...outcome.lastError, attempts: attempt };
        await sleep(outcome.retryInMs);
      }
    },
  };
}
