import { expect, test as setup } from '@playwright/test';
import { ADMIN_STORAGE_STATE, E2E_ADMIN_EMAIL, getE2eAdminPassword } from './e2e-env';

setup('올바른 계정으로 로그인하면 오늘 화면으로 이동하고 세션을 저장한다', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('비밀번호').fill(getE2eAdminPassword());
  await page.getByRole('button', { name: '로그인', exact: true }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1, name: '오늘' })).toBeVisible();

  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
