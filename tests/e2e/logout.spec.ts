import { expect, test } from '@playwright/test';

// logout 프로젝트: 공유 세션을 끝내므로 chromium 프로젝트가 모두 끝난 뒤 실행된다.

test('로그아웃하면 /login으로 가고, 이후 / 접근과 이전 세션 쿠키도 막힌다', async ({ page, request }) => {
  await page.goto('/');
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL('/login');

  await page.goto('/');
  await expect(page).toHaveURL('/login');

  // 브라우저 쿠키 삭제만이 아니라 서버 세션도 끝났는지 확인한다.
  const response = await request.get('/', { headers: { Cookie: cookieHeader }, maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()['location']).toMatch(/\/login(\?|$)/);
});
