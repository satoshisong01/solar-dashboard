// POST /api/ingest/v1 처리 (설계 §5.1). 기계용 엔드포인트라 세션이 아니라 게이트웨이 HMAC으로만 인증한다.
// 순서: gzip 헤더 → 서명 헤더·시각 → 본문 크기 → DB 풀 → 키 조회·서명 검증 → 압축 해제 → zod → 저장 → after()로 롤업.
// Next의 after()는 요청 범위 밖에서 호출할 수 없으므로 schedule로 주입받는다 (테스트는 직접 실행).
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { BodyTooLargeError, decodeGzipJson, InvalidBodyError, readBodyLimited } from './body';
import { parseEnvelope } from './envelope';
import { findActiveGatewayKey } from './keys';
import { clockSkewFromSignature } from './normalize';
import { ingestEnvelope } from './pipeline';
import { drainDirty } from './rollup';
import { checkTimestamp, readSignatureHeaders, verifySignature, type SignatureHeaderValues } from './signature';
import type { IngestCounts } from './store';

export const SERVER_TIME_HEADER = 'X-OM-Server-Time';
const RETRY_AFTER_BUSY_S = 5;
const RETRY_AFTER_UNAVAILABLE_S = 30;

export interface IngestDeps {
  readonly db: Kysely<DB>;
  /** INGEST_KEY_ENC_KEY를 디코딩한 32바이트 키 (첫 요청 때 읽는다) */
  readonly encryptionKey: () => Uint8Array;
  readonly nowMs: () => number;
  /** DB 풀 대기열이 가득 찼으면 true → 429 */
  readonly isDbSaturated: () => boolean;
  /** 응답 뒤 실행할 작업 (라우트에서는 next/server의 after) */
  readonly schedule: (task: () => Promise<void>) => void;
}

export interface IngestSuccessBody extends IngestCounts {
  readonly status: 'accepted' | 'duplicate';
}

export interface IngestErrorBody {
  readonly status: 'error';
  readonly error: string;
  readonly message: string;
  readonly issues?: readonly string[];
}

class IngestHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    readonly issues?: readonly string[],
  ) {
    super(message);
    this.name = 'IngestHttpError';
  }
}

const unauthorized = (code: string, message: string) => new IngestHttpError(401, code, message);

function json(status: number, body: IngestSuccessBody | IngestErrorBody, headers: Readonly<Record<string, string>> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function assertGzipEncoding(headers: Headers): void {
  if (headers.get('content-encoding')?.trim().toLowerCase() !== 'gzip') {
    throw new IngestHttpError(400, 'gzip_required', 'Content-Encoding: gzip 본문만 받습니다');
  }
}

function readVerifiableHeaders(headers: Headers, nowMs: number): SignatureHeaderValues {
  const values = readSignatureHeaders(headers);
  if (!values) throw unauthorized('signature_missing', 'X-OM-Key-Id·X-OM-Timestamp·X-OM-Signature 헤더가 없거나 형식이 틀립니다');
  if (!checkTimestamp(values.timestamp, Math.floor(nowMs / 1000))) {
    throw unauthorized('clock_skew', '서명 시각이 서버 시각과 300초 넘게 차이 납니다');
  }
  return values;
}

async function readCompressedBody(request: Request): Promise<Buffer> {
  try {
    return await readBodyLimited(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new IngestHttpError(413, 'payload_too_large', error.message);
    throw new IngestHttpError(400, 'body_unreadable', '요청 본문을 읽지 못했습니다');
  }
}

async function authenticate(deps: IngestDeps, headers: SignatureHeaderValues, body: Uint8Array, nowMs: number) {
  const key = await findActiveGatewayKey(deps.db, headers.keyId, deps.encryptionKey());
  if (!key) throw unauthorized('unknown_key', '등록되지 않았거나 폐기된 키입니다');
  if (!key.gatewayActive) throw unauthorized('gateway_disabled', '비활성화된 게이트웨이입니다');

  const check = verifySignature({ headers, secret: key.secret, body, nowSec: Math.floor(nowMs / 1000) });
  if (!check.ok) throw unauthorized(check.reason, check.reason === 'clock_skew' ? '서명 시각이 허용 범위를 벗어났습니다' : '서명이 일치하지 않습니다');
  return key;
}

async function decodeBody(body: Uint8Array) {
  try {
    return await decodeGzipJson(body);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new IngestHttpError(413, 'payload_too_large', error.message);
    if (error instanceof InvalidBodyError) throw new IngestHttpError(400, 'invalid_body', error.message);
    throw error;
  }
}

async function rollupAfterIngest(db: Kysely<DB>, pointIds: readonly number[]): Promise<void> {
  try {
    await drainDirty(db, { pointIds });
  } catch (error) {
    // 실패해도 dirty 행이 남으므로 다음 수집·분석 실행 때 다시 처리된다.
    console.error('[ingest] 수집 후 롤업 실패:', error instanceof Error ? error.message : error);
  }
}

async function processRequest(request: Request, deps: IngestDeps): Promise<Response> {
  const receivedAtMs = deps.nowMs();
  assertGzipEncoding(request.headers);
  const signatureHeaders = readVerifiableHeaders(request.headers, receivedAtMs);
  const bodyGzip = await readCompressedBody(request);
  if (deps.isDbSaturated()) {
    throw new IngestHttpError(429, 'busy', '수집 요청이 몰려 있습니다. 잠시 후 다시 보내세요', { 'Retry-After': String(RETRY_AFTER_BUSY_S) });
  }

  const key = await authenticate(deps, signatureHeaders, bodyGzip, receivedAtMs);
  const { json: payload, raw } = await decodeBody(bodyGzip);
  const parsed = parseEnvelope(payload);
  if (!parsed.ok) throw new IngestHttpError(400, 'invalid_envelope', '봉투가 om.ingest.v1 스키마와 맞지 않습니다', {}, parsed.issues);
  if (parsed.envelope.gateway !== key.gatewayCode) throw unauthorized('gateway_mismatch', '봉투의 gateway가 서명 키의 게이트웨이와 다릅니다');

  const result = await ingestEnvelope(deps.db, {
    gatewayId: key.gatewayId,
    siteId: key.siteId,
    envelope: parsed.envelope,
    bodyGzip,
    bodyJson: raw,
    receivedAtMs,
    clockSkewMs: clockSkewFromSignature(Number(signatureHeaders.timestamp), receivedAtMs),
  });
  if (result.kind === 'conflict') {
    throw new IngestHttpError(409, 'batch_conflict', '같은 batch_id로 다른 본문이 이미 수신됐습니다');
  }
  if (result.kind === 'stored' && result.pointIds.length > 0) {
    const { pointIds } = result;
    deps.schedule(() => rollupAfterIngest(deps.db, pointIds));
  }
  return json(200, { status: result.kind === 'stored' ? 'accepted' : 'duplicate', ...result.counts });
}

const UNAVAILABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
// too_many_connections, admin_shutdown, crash_shutdown, cannot_connect_now
const UNAVAILABLE_PG_CODES = new Set(['53300', '57P01', '57P02', '57P03']);

function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return (
    UNAVAILABLE_NETWORK_CODES.has(code) ||
    UNAVAILABLE_PG_CODES.has(code) ||
    code.startsWith('08') || // connection_exception
    /Connection terminated/i.test(error.message)
  );
}

function errorResponse(error: unknown, nowMs: number): Response {
  if (error instanceof IngestHttpError) {
    const headers = error.httpStatus === 401 ? { ...error.headers, [SERVER_TIME_HEADER]: String(Math.floor(nowMs / 1000)) } : error.headers;
    return json(error.httpStatus, { status: 'error', error: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) }, headers);
  }
  if (isDatabaseUnavailable(error)) {
    console.error('[ingest] DB 연결 불가:', error instanceof Error ? error.message : error);
    return json(503, { status: 'error', error: 'unavailable', message: '저장소에 연결할 수 없습니다. 잠시 후 다시 보내세요' }, { 'Retry-After': String(RETRY_AFTER_UNAVAILABLE_S) });
  }
  console.error('[ingest] 처리 실패:', error);
  return json(500, { status: 'error', error: 'internal', message: '수집 처리 중 서버 오류가 발생했습니다' });
}

/** 게이트웨이 배치 수집. 실패는 모두 JSON 오류 응답으로 바꾼다 (예외를 밖으로 던지지 않음). */
export async function handleIngestRequest(request: Request, deps: IngestDeps): Promise<Response> {
  try {
    return await processRequest(request, deps);
  } catch (error) {
    return errorResponse(error, deps.nowMs());
  }
}
