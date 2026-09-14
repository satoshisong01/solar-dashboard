// 수집 본문 읽기·압축 해제 (크기 상한 포함). 수집 라우트와 재처리가 함께 쓴다.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

/** 압축된 본문 상한 (Vercel 요청 본문 4.5 MB 아래) */
export const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
/** 압축 해제 후 상한 (압축 폭탄 방지) */
export const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;

const gunzipAsync = promisify(gunzip);

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number, readonly stage: 'compressed' | 'decompressed') {
    super(`${stage === 'compressed' ? '압축된' : '압축을 푼'} 본문이 ${limitBytes}바이트를 넘습니다`);
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBodyError';
  }
}

/** Content-Length를 먼저 보고, 실제로 읽은 바이트도 상한을 넘으면 읽기를 멈춘다. */
export async function readBodyLimited(request: Request, maxBytes = MAX_COMPRESSED_BYTES): Promise<Buffer> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes, 'compressed');
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes, 'compressed');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** gzip을 풀고 UTF-8 JSON으로 파싱한다. 원문 바이트도 함께 돌려준다 (본문 해시용). */
export async function decodeGzipJson(body: Uint8Array, maxBytes = MAX_DECOMPRESSED_BYTES): Promise<{ readonly json: unknown; readonly raw: Buffer }> {
  let raw: Buffer;
  try {
    raw = await gunzipAsync(body, { maxOutputLength: maxBytes });
  } catch (error) {
    if (errorCode(error) === 'ERR_BUFFER_TOO_LARGE') throw new BodyTooLargeError(maxBytes, 'decompressed');
    throw new InvalidBodyError('gzip 본문을 풀 수 없습니다');
  }
  try {
    return { json: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    throw new InvalidBodyError('본문이 올바른 JSON이 아닙니다');
  }
}

export function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}
