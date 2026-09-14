import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readSignatureHeaders, signBatch, verifySignature, type SignatureHeaders } from './signature';

const KEY_ID = 'gk_sim-b_dev';
const SECRET = 'dev-secret-0123456789abcdefghijklmnop';
const NOW_S = 1_757_819_100;
const BODY = gzipSync(Buffer.from('{"schema":"om.ingest.v1"}'));

function headersOf(signed: SignatureHeaders): Headers {
  return new Headers(signed);
}

function verify(signed: SignatureHeaders, overrides: { body?: Uint8Array; secret?: string; nowSec?: number } = {}) {
  const headers = readSignatureHeaders(headersOf(signed));
  if (!headers) throw new Error('헤더를 읽지 못했습니다');
  return verifySignature({ headers, secret: overrides.secret ?? SECRET, body: overrides.body ?? BODY, nowSec: overrides.nowSec ?? NOW_S });
}

describe('signBatch', () => {
  it('v1=hex(HMAC_SHA256(secret, keyId.ts.sha256hex(body))) 형식으로 헤더 3개를 만든다', () => {
    const bodyHash = createHash('sha256').update(BODY).digest('hex');
    const expected = createHmac('sha256', SECRET).update(`${KEY_ID}.${NOW_S}.${bodyHash}`).digest('hex');

    expect(signBatch(KEY_ID, SECRET, NOW_S, BODY)).toEqual({
      'X-OM-Key-Id': KEY_ID,
      'X-OM-Timestamp': String(NOW_S),
      'X-OM-Signature': `v1=${expected}`,
    });
  });

  it('소수 초는 버리고, 잘못된 키 ID·빈 비밀값은 거부한다', () => {
    expect(signBatch(KEY_ID, SECRET, NOW_S + 0.9, BODY)['X-OM-Timestamp']).toBe(String(NOW_S));
    expect(() => signBatch('키 id', SECRET, NOW_S, BODY)).toThrow(/키 ID/);
    expect(() => signBatch(KEY_ID, '', NOW_S, BODY)).toThrow(/비어 있습니다/);
  });
});

describe('verifySignature', () => {
  it('같은 비밀값·본문이면 통과한다', () => {
    expect(verify(signBatch(KEY_ID, SECRET, NOW_S, BODY))).toEqual({ ok: true });
  });

  it('본문이 1바이트라도 바뀌면 bad_signature', () => {
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 1] ^= 0x01;

    expect(verify(signBatch(KEY_ID, SECRET, NOW_S, BODY), { body: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('비밀값이 다르거나 키 ID·시각 헤더를 바꿔 끼우면 bad_signature', () => {
    const signed = signBatch(KEY_ID, SECRET, NOW_S, BODY);

    expect(verify(signed, { secret: `${SECRET}x` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ ...signed, 'X-OM-Key-Id': 'gk_sim-c_dev' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ ...signed, 'X-OM-Timestamp': String(NOW_S + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('서명 시각이 ±300초까지는 받고, 넘으면 clock_skew', () => {
    const signed = signBatch(KEY_ID, SECRET, NOW_S, BODY);

    expect(verify(signed, { nowSec: NOW_S + 300 })).toEqual({ ok: true });
    expect(verify(signed, { nowSec: NOW_S - 300 })).toEqual({ ok: true });
    expect(verify(signed, { nowSec: NOW_S + 301 })).toEqual({ ok: false, reason: 'clock_skew' });
    expect(verify(signed, { nowSec: NOW_S - 301 })).toEqual({ ok: false, reason: 'clock_skew' });
  });
});

describe('readSignatureHeaders', () => {
  it('대문자 hex 서명도 받는다 (소문자로 바꿔 비교)', () => {
    const signed = signBatch(KEY_ID, SECRET, NOW_S, BODY);
    const upper = { ...signed, 'X-OM-Signature': `v1=${signed['X-OM-Signature'].slice(3).toUpperCase()}` };

    expect(verify(upper)).toEqual({ ok: true });
  });

  it.each([
    ['서명 헤더가 없으면', { 'X-OM-Signature': '' }],
    ['버전 접두어가 없으면', { 'X-OM-Signature': 'a'.repeat(64) }],
    ['hex 길이가 틀리면', { 'X-OM-Signature': `v1=${'a'.repeat(63)}` }],
    ['시각이 숫자가 아니면', { 'X-OM-Timestamp': '2026-09-14T03:05:00Z' }],
    ['시각이 0으로 시작하면', { 'X-OM-Timestamp': `0${NOW_S}` }],
    ['키 ID가 없으면', { 'X-OM-Key-Id': '' }],
  ])('%s null', (_label, patch) => {
    const signed = { ...signBatch(KEY_ID, SECRET, NOW_S, BODY), ...patch };

    expect(readSignatureHeaders(headersOf(signed))).toBeNull();
  });
});
