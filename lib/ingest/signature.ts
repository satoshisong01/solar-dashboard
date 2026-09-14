// 게이트웨이 배치 HMAC 서명 (설계 §5.1). 순수 모듈: 시뮬레이터(lib/sim)도 import한다 ('server-only' 금지).
//   X-OM-Signature: v1=hex(HMAC_SHA256(secret, keyId + "." + ts + "." + sha256hex(body)))
// body는 전송하는 gzip 본문 바이트 그대로다. secret은 발급받은 문자열의 UTF-8 바이트를 키로 쓴다.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADERS = Object.freeze({
  keyId: 'X-OM-Key-Id',
  timestamp: 'X-OM-Timestamp',
  signature: 'X-OM-Signature',
} as const);

/** 서명 시각 허용 오차 (초) */
export const SIGNATURE_TOLERANCE_S = 300;

const SIGNATURE_PREFIX = 'v1=';
const SIGNATURE_PATTERN = /^v1=[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^[1-9][0-9]{0,11}$/;
/** 키 ID 형식 (헤더에 그대로 싣는다) */
export const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type SignatureHeaders = Readonly<Record<(typeof SIGNATURE_HEADERS)[keyof typeof SIGNATURE_HEADERS], string>>;

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function computeSignature(keyId: string, timestamp: string, secret: string, body: Uint8Array): string {
  const digest = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${keyId}.${timestamp}.${sha256Hex(body)}`, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

/** 요청 헤더 3개를 만든다. timestampSec는 Unix 초. */
export function signBatch(keyId: string, secret: string, timestampSec: number, rawGzipBody: Uint8Array): SignatureHeaders {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`키 ID 형식이 올바르지 않습니다: ${keyId}`);
  if (secret.length === 0) throw new Error('서명 비밀값이 비어 있습니다');
  const timestamp = String(Math.trunc(timestampSec));
  if (!TIMESTAMP_PATTERN.test(timestamp)) throw new Error(`서명 시각이 올바르지 않습니다: ${timestampSec}`);

  return {
    [SIGNATURE_HEADERS.keyId]: keyId,
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.signature]: computeSignature(keyId, timestamp, secret, rawGzipBody),
  };
}

export interface SignatureHeaderValues {
  readonly keyId: string;
  readonly timestamp: string;
  readonly signature: string;
}

/** 헤더에서 서명 값 3개를 꺼낸다. 하나라도 없거나 형식이 틀리면 null. */
export function readSignatureHeaders(headers: Headers): SignatureHeaderValues | null {
  const keyId = headers.get(SIGNATURE_HEADERS.keyId)?.trim() ?? '';
  const timestamp = headers.get(SIGNATURE_HEADERS.timestamp)?.trim() ?? '';
  const signature = headers.get(SIGNATURE_HEADERS.signature)?.trim().toLowerCase() ?? '';
  if (!KEY_ID_PATTERN.test(keyId) || !TIMESTAMP_PATTERN.test(timestamp) || !SIGNATURE_PATTERN.test(signature)) {
    return null;
  }
  return { keyId, timestamp, signature };
}

export type SignatureCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'clock_skew' | 'bad_signature' };

/** 시각이 ±300초 밖이면 clock_skew. 시각을 먼저 보므로 비밀값 없이도 호출 전에 거를 수 있다. */
export function checkTimestamp(timestamp: string, nowSec: number, toleranceSec = SIGNATURE_TOLERANCE_S): boolean {
  return Math.abs(Number(timestamp) - nowSec) <= toleranceSec;
}

export interface VerifySignatureInput {
  readonly headers: SignatureHeaderValues;
  readonly secret: string;
  readonly body: Uint8Array;
  readonly nowSec: number;
  readonly toleranceSec?: number;
}

export function verifySignature({ headers, secret, body, nowSec, toleranceSec }: VerifySignatureInput): SignatureCheck {
  if (!checkTimestamp(headers.timestamp, nowSec, toleranceSec)) return { ok: false, reason: 'clock_skew' };

  const expected = Buffer.from(computeSignature(headers.keyId, headers.timestamp, secret, body), 'utf8');
  const received = Buffer.from(headers.signature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
