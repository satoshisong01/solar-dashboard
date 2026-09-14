import { expect, test } from '@playwright/test';
import { SIGNED_OUT } from './e2e-env';

const QUERY = 'pointIds=1&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z';

test.describe('비로그인 /api/series', () => {
  test.use({ storageState: SIGNED_OUT });

  test('로그인 화면으로 보내지 않고 401 JSON을 준다', async ({ request }) => {
    const response = await request.get(`/api/series?${QUERY}`, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  test('위조한 세션 쿠키도 401 JSON', async ({ request }) => {
    const response = await request.get(`/api/series?${QUERY}`, {
      headers: { Cookie: 'better-auth.session_token=forged-token.forged-signature' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

test.describe('로그인 세션 /api/series', () => {
  // chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.

  test('24시간 조회는 원시 기반 버킷으로 응답한다 (데이터가 없으면 빈 rows)', async ({ request }) => {
    const response = await request.get(`/api/series?${QUERY}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ source: 'raw', bucketSeconds: 300, series: [{ pointId: 1 }] });
    expect(Array.isArray(body.series[0].rows)).toBe(true);
  });

  test('잘못된 쿼리는 400 JSON', async ({ request }) => {
    const response = await request.get('/api/series?pointIds=abc&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z');
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_query' });
  });
});
