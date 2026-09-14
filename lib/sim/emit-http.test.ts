import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '@/lib/ingest/envelope';
import { readSignatureHeaders, verifySignature } from '@/lib/ingest/signature';
import { createHttpEmitter, simulatedClockSkewMs, type EmitBatch, type HttpEmitterOptions } from './emit-http';
import { buildEnvelope } from './envelope';

const SIM_SENT_AT = Date.parse('2026-08-20T01:05:00.500Z');
const NOW = Date.parse('2026-09-14T10:00:00.000Z');
const SECRET = 'sim-secret-0123456789-abcdefghijklmnop';
const CREDENTIALS = new Map([['GW-SIMB-01', { keyId: 'gk_sim-b_dev', secret: SECRET }]]);
const COUNTS = { accepted: 3, duplicate: 0, rejected: 0, unmapped: 0, missing: 0, events: 1 };

function simBatch(skewMs = 0): EmitBatch {
  const envelope = buildEnvelope({
    seed: 42,
    gateway: 'GW-SIMB-01',
    seq: 100,
    sentAtMs: SIM_SENT_AT + skewMs,
    clock: skewMs === 0 ? { ntp_synced: true, ntp_offset_ms: 2 } : { ntp_synced: false, ntp_offset_ms: 0 },
    samples: [0, 1, 2].map((i) => ({ sourceKey: 'PV1/INV01/P_AC', unit: 'kW', periodS: 60, ts: SIM_SENT_AT - 300_500 + skewMs + i * 60_000, value: 10 + i })),
    events: [{ src: 'GD3/ALARM', ts: SIM_SENT_AT - 1_000 + skewMs, code: 'H2_LEAK_L1', severity: 'critical', text: '경보' }],
  });
  return { envelope, sentAtMs: SIM_SENT_AT };
}

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

/** 요청을 기록하고 준비한 응답을 차례로 돌려주는 fetch. 응답 대신 Error를 넣으면 네트워크 오류로 던진다. */
function fakeFetch(responses: readonly (Response | Error)[]) {
  const requests: Captured[] = [];
  let index = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const body = Buffer.from(init?.body as Uint8Array);
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next || next instanceof Error) throw next ?? new Error('응답 없음');
    return next.clone();
  };
  return { fetchFn, requests };
}

const ok = (status: 'accepted' | 'duplicate' = 'accepted') => Response.json({ status, ...COUNTS });
const errorResponse = (httpStatus: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ status: 'error', error, message: `${error} 메시지` }, { status: httpStatus, headers });

function emitterWith(responses: readonly (Response | Error)[], overrides: Partial<HttpEmitterOptions> = {}) {
  const { fetchFn, requests } = fakeFetch(responses);
  const sleeps: number[] = [];
  const emitter = createHttpEmitter({
    baseUrl: 'http://localhost:3000',
    credentials: CREDENTIALS,
    fetch: fetchFn,
    nowMs: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { emitter, requests, sleeps };
}

describe('simulatedClockSkewMs', () => {
  it('봉투 sent_at − 실제 전송 시각이다', () => {
    expect(simulatedClockSkewMs(simBatch())).toBe(0);
    expect(simulatedClockSkewMs(simBatch(200_000))).toBe(200_000);
  });
});

describe('createHttpEmitter', () => {
  it('gzip 본문을 서버 규칙으로 서명해 /api/ingest/v1에 보내고, 풀면 om.ingest.v1 봉투다', async () => {
    const { emitter, requests } = emitterWith([ok()]);
    const batch = simBatch();

    await expect(emitter.emit(batch)).resolves.toEqual({ kind: 'accepted', counts: COUNTS, attempts: 1 });
    const [request] = requests;
    if (!request) throw new Error('요청이 없습니다');
    const headers = readSignatureHeaders(request.headers);
    if (!headers) throw new Error('서명 헤더가 없습니다');

    expect(request.url).toBe('http://localhost:3000/api/ingest/v1');
    expect(request.headers.get('content-encoding')).toBe('gzip');
    expect(headers.keyId).toBe('gk_sim-b_dev');
    expect(verifySignature({ headers, secret: SECRET, body: request.body, nowSec: NOW / 1000 })).toEqual({ ok: true });
    const parsed = parseEnvelope(JSON.parse(gunzipSync(request.body).toString('utf8')));
    expect(parsed.ok && parsed.envelope).toMatchObject({ batch_id: batch.envelope.batch_id, sent_at: new Date(SIM_SENT_AT).toISOString() });
  });

  it('본문은 시뮬레이터 봉투 그대로라, 다른 시각에 다시 실행해도(새 전송기) 서버가 해시하는 JSON이 같다', async () => {
    const first = emitterWith([ok()]);
    const rerun = emitterWith([ok('duplicate')], { nowMs: () => NOW + 3_600_000 });

    await first.emitter.emit(simBatch());
    await expect(rerun.emitter.emit(simBatch())).resolves.toMatchObject({ kind: 'duplicate' });

    const json = (captured: { body: Buffer } | undefined) => gunzipSync(captured?.body ?? Buffer.alloc(0)).toString('utf8');
    expect(json(rerun.requests[0])).toBe(json(first.requests[0]));
    expect(json(first.requests[0])).toBe(JSON.stringify(simBatch().envelope));
    expect(rerun.requests[0]?.headers.get('x-om-timestamp')).toBe(String((NOW + 3_600_000) / 1000));
  });

  it('시계 오차가 있는 배치는 게이트웨이 시계로 서명 시각을 찍는다', async () => {
    const { emitter, requests } = emitterWith([ok()]);

    await emitter.emit(simBatch(200_000));

    expect(requests[0]?.headers.get('x-om-timestamp')).toBe(String((NOW + 200_000) / 1000));
  });

  it('같은 봉투 객체를 다시 보내면(재전송) 시각이 달라도 본문 바이트가 같다', async () => {
    let now = NOW;
    const { emitter, requests } = emitterWith([ok(), ok('duplicate')], { nowMs: () => now });
    const batch = simBatch();

    await emitter.emit(batch);
    now += 5_000;
    await expect(emitter.emit(batch)).resolves.toMatchObject({ kind: 'duplicate' });

    expect(requests[1]?.body.equals(requests[0]?.body ?? Buffer.alloc(0))).toBe(true);
    expect(requests[1]?.headers.get('x-om-timestamp')).toBe(String((NOW + 5_000) / 1000));
  });

  it('429·503은 Retry-After만큼 기다렸다가, 네트워크 오류는 점점 늘려 기다렸다가 같은 본문으로 다시 보낸다', async () => {
    const { emitter, requests, sleeps } = emitterWith([errorResponse(429, 'busy', { 'Retry-After': '2' }), new TypeError('fetch failed'), errorResponse(503, 'unavailable'), ok()]);

    await expect(emitter.emit(simBatch())).resolves.toMatchObject({ kind: 'accepted', attempts: 4 });

    expect(sleeps).toEqual([2_000, 2_000, 5_000]);
    expect(new Set(requests.map((r) => r.body.toString('hex'))).size).toBe(1);
  });

  it('재시도 횟수를 다 쓰면 마지막 오류로 실패한다', async () => {
    const { emitter, requests } = emitterWith([errorResponse(503, 'unavailable', { 'Retry-After': '1' })], { maxAttempts: 3 });

    await expect(emitter.emit(simBatch())).resolves.toEqual({ kind: 'failed', httpStatus: 503, error: '503 unavailable: unavailable 메시지', attempts: 3 });
    expect(requests).toHaveLength(3);
  });

  it('409는 conflict, 400·401은 재시도 없이 실패로 돌려준다', async () => {
    const conflict = emitterWith([errorResponse(409, 'batch_conflict')]);
    const unauthorized = emitterWith([errorResponse(401, 'bad_signature')]);

    await expect(conflict.emitter.emit(simBatch())).resolves.toEqual({ kind: 'conflict', attempts: 1 });
    await expect(unauthorized.emitter.emit(simBatch())).resolves.toMatchObject({ kind: 'failed', httpStatus: 401, error: '401 bad_signature: bad_signature 메시지' });
    expect(unauthorized.requests).toHaveLength(1);
  });

  it('게이트웨이 자격 증명이 없거나 응답 본문이 수집 응답 형식이 아니면 실패', async () => {
    const missing = emitterWith([ok()], { credentials: new Map() });
    const garbage = emitterWith([new Response('<html>', { status: 200 })]);

    await expect(missing.emitter.emit(simBatch())).resolves.toMatchObject({ kind: 'failed', httpStatus: null, error: expect.stringContaining('GW-SIMB-01') });
    expect(missing.requests).toHaveLength(0);
    await expect(garbage.emitter.emit(simBatch())).resolves.toMatchObject({ kind: 'failed', httpStatus: 200 });
  });
});
