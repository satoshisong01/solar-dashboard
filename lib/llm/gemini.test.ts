// Gemini 제공자: 실제 API 대신 가짜 fetch로 성공·429·5xx·타임아웃·네트워크 재시도·빈 응답을 확인한다.
import { describe, expect, it, vi } from 'vitest';
import { createGeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini';
import type { LlmRequest } from './types';

const REQUEST: LlmRequest = { system: '시스템', user: '{"a":1}', temperature: 0.2, maxOutputTokens: 100 };

const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('{}', { status: code, headers: { 'content-type': 'application/json' } });

const providerWith = (fetchImpl: Parameters<typeof createGeminiProvider>[0]['fetchImpl'], timeoutMs = 50) =>
  createGeminiProvider({ apiKey: 'secret-key', model: 'fake-model', fetchImpl, timeoutMs });

describe('createGeminiProvider', () => {
  it('본문을 돌려주고, 키는 헤더로만 보낸다 (URL에 넣지 않는다)', async () => {
    const fetchImpl = vi.fn(async () => ok('{"what":"좋아졌습니다"}'));

    const outcome = await providerWith(fetchImpl).complete(REQUEST);

    expect(outcome).toEqual({ ok: true, text: '{"what":"좋아졌습니다"}' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/fake-model:generateContent');
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toMatchObject({ temperature: 0.2, maxOutputTokens: 100, responseMimeType: 'application/json' });
    expect(body.systemInstruction.parts[0].text).toBe('시스템');
  });

  it('429는 다시 시도하지 않고 즉시 폴백한다', async () => {
    const fetchImpl = vi.fn(async () => status(429));

    const outcome = await providerWith(fetchImpl).complete(REQUEST);

    expect(outcome).toEqual({ ok: false, reason: 'rate_limited', detail: 'HTTP 429' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('5xx도 즉시 폴백한다', async () => {
    const fetchImpl = vi.fn(async () => status(503));

    const outcome = await providerWith(fetchImpl).complete(REQUEST);

    expect(outcome).toEqual({ ok: false, reason: 'server_error', detail: 'HTTP 503' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('4xx는 응답을 읽을 수 없는 것으로 본다', async () => {
    const outcome = await providerWith(vi.fn(async () => status(400))).complete(REQUEST);

    expect(outcome).toEqual({ ok: false, reason: 'bad_response', detail: 'HTTP 400' });
  });

  it('제한 시간을 넘기면 끊고 폴백한다 (다시 기다리지 않는다)', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const outcome = await providerWith(fetchImpl, 20).complete(REQUEST);

    expect(outcome).toEqual({ ok: false, reason: 'timeout', detail: '20ms 안에 응답이 없습니다' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('네트워크 오류는 한 번만 다시 시도한다', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(ok('{}'));

    const outcome = await providerWith(fetchImpl).complete(REQUEST);

    expect(outcome).toEqual({ ok: true, text: '{}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('두 번 다 네트워크 오류면 폴백한다', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const outcome = await providerWith(fetchImpl).complete(REQUEST);

    expect(outcome).toEqual({ ok: false, reason: 'transport_error', detail: 'ECONNRESET' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('생성이 중간에 끊기거나 본문이 비면 폴백한다', async () => {
    const cut = new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"wh' }] } }] }), { status: 200 });
    expect(await providerWith(vi.fn(async () => cut)).complete(REQUEST)).toEqual({ ok: false, reason: 'bad_response', detail: '생성이 MAX_TOKENS(으)로 끝났습니다' });

    const blocked = new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }], promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 });
    expect(await providerWith(vi.fn(async () => blocked)).complete(REQUEST)).toEqual({ ok: false, reason: 'bad_response', detail: '요청이 차단됐습니다(SAFETY)' });
  });

  it('기본 모델 id는 flash 계열이다', () => {
    expect(DEFAULT_GEMINI_MODEL).toMatch(/flash/);
  });
});
