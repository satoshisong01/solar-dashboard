import { expect, test, type APIResponse } from '@playwright/test';
import { CONSOLE_ROUTES, SIGNED_OUT } from './e2e-env';

test.use({ storageState: SIGNED_OUT });

// 콘솔 화면에만 있는 표식. 로그인 화면에는 없다.
const CONSOLE_MARKERS = ['주 메뉴', '로그아웃'];
const LOGIN_LOCATION = /^(http:\/\/localhost:\d+)?\/login(\?|$)/;

test.describe('비로그인 브라우저 접근', () => {
  for (const { href } of CONSOLE_ROUTES) {
    test(`${href} → /login`, async ({ page }) => {
      await page.goto(href);

      await expect(page).toHaveURL('/login');
      await expect(page.getByRole('heading', { name: '관리자 로그인' })).toBeVisible();
    });
  }
});

test.describe('비로그인 서버 직접 호출은 콘솔 HTML을 받지 못한다', () => {
  async function expectRedirectToLogin(response: APIResponse): Promise<void> {
    expect(response.status()).toBe(307);
    expect(response.headers()['location']).toMatch(LOGIN_LOCATION);
    const body = await response.text();
    for (const marker of CONSOLE_MARKERS) expect(body).not.toContain(marker);
  }

  for (const { href } of CONSOLE_ROUTES) {
    test(`GET ${href}`, async ({ request }) => {
      await expectRedirectToLogin(await request.get(href, { maxRedirects: 0 }));
    });
  }

  test('RSC 내비게이션 요청(RSC: 1)', async ({ request }) => {
    await expectRedirectToLogin(await request.get('/fleet', { headers: { RSC: '1' }, maxRedirects: 0 }));
  });

  test('Server Action 형식의 POST', async ({ request }) => {
    const response = await request.post('/', {
      headers: { 'Next-Action': '0'.repeat(42) },
      data: '[]',
      maxRedirects: 0,
    });
    await expectRedirectToLogin(response);
  });

  test('위조한 세션 쿠키는 proxy를 지나도 requireAdmin에서 막힌다', async ({ request }) => {
    const response = await request.get('/fleet', {
      headers: { Cookie: 'better-auth.session_token=forged-token.forged-signature' },
      maxRedirects: 0,
    });
    await expectRedirectToLogin(response);
  });
});
