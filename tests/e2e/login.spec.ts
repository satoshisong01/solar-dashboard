import { expect, test } from '@playwright/test';
import { E2E_ADMIN_EMAIL, SIGNED_OUT } from './e2e-env';

test.use({ storageState: SIGNED_OUT });

test('잘못된 비밀번호면 한국어 오류를 보여 주고 로그인 화면에 남는다', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('비밀번호').fill('wrong-password-1234');
  const submit = page.getByRole('button', { name: '로그인', exact: true });
  await submit.click();

  // Next의 경로 안내 요소도 role="alert"라서 문구로 좁힌다.
  await expect(page.getByRole('alert').filter({ hasText: '이메일 또는 비밀번호가 올바르지 않습니다.' })).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(page).toHaveURL('/login');
});
