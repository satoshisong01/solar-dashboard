import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, decodeGzipJson, InvalidBodyError, readBodyLimited } from './body';

const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request('http://localhost/api/ingest/v1', { method: 'POST', body, headers });

describe('readBodyLimited', () => {
  it('상한 이하 본문을 그대로 읽는다', async () => {
    const body = Buffer.from('hello');

    expect((await readBodyLimited(post(body), 5)).equals(body)).toBe(true);
  });

  it('Content-Length가 상한을 넘으면 읽기 전에 거부한다', async () => {
    await expect(readBodyLimited(post('x', { 'content-length': '6' }), 5)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('헤더 없이 스트림으로 상한을 넘어도 거부한다', async () => {
    await expect(readBodyLimited(post(Buffer.alloc(6)), 5)).rejects.toMatchObject({ stage: 'compressed', limitBytes: 5 });
  });
});

describe('decodeGzipJson', () => {
  it('gzip JSON을 풀어 값과 원문 바이트를 돌려준다', async () => {
    const raw = Buffer.from('{"a":[1,null]}');

    const result = await decodeGzipJson(gzipSync(raw));

    expect(result.json).toEqual({ a: [1, null] });
    expect(result.raw.equals(raw)).toBe(true);
  });

  it('압축을 푼 크기가 상한을 넘으면 BodyTooLargeError', async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x20));

    await expect(decodeGzipJson(bomb, 1024)).rejects.toMatchObject({ stage: 'decompressed' });
  });

  it('gzip이 아니거나 JSON이 아니면 InvalidBodyError', async () => {
    await expect(decodeGzipJson(Buffer.from('{"a":1}'))).rejects.toBeInstanceOf(InvalidBodyError);
    await expect(decodeGzipJson(gzipSync('not json'))).rejects.toThrow(/JSON/);
  });
});
