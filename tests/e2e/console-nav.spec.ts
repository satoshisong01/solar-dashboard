import { expect, test } from '@playwright/test';
import { CONSOLE_ROUTES } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.

test('로그인 후 사이드바에 HySol Desk와 메뉴 11개가 보인다', async ({ page }) => {
  await page.goto('/');

  // 데스크톱 너비에서는 모바일 탭 메뉴가 숨겨져 사이드바 메뉴만 잡힌다.
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  await expect(page.getByRole('link', { name: /HySol Desk/ })).toBeVisible();
  await expect(nav.getByRole('link')).toHaveText(CONSOLE_ROUTES.map((route) => route.title));
});

test('메뉴를 누르면 해당 화면 제목과 활성 표시가 바뀐다', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '주 메뉴' });

  for (const { href, title } of CONSOLE_ROUTES) {
    const link = nav.getByRole('link', { name: title, exact: true });
    await link.click();

    await expect(page).toHaveURL(href);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(link).toHaveAttribute('aria-current', 'page');
  }
});
