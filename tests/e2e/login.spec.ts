import { expect, test } from '@playwright/test';
import { E2E_ADMIN_EMAIL, SIGNED_OUT, getE2eAdminPassword } from './e2e-env';

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

test('아이디 저장을 켜 두면 다음 로그인 화면에 이메일이 채워지고, 해제하면 지워진다', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('아이디 저장')).not.toBeChecked();
  await page.getByLabel('이메일').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('비밀번호').fill(getE2eAdminPassword());
  await page.getByLabel('아이디 저장').check();
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL('/');

  // 이 테스트가 만든 세션만 끝낸다. 공유 세션(storageState)은 logout 프로젝트에서 다룬다.
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByLabel('이메일')).toHaveValue(E2E_ADMIN_EMAIL);
  await expect(page.getByLabel('아이디 저장')).toBeChecked();
  // 비밀번호는 저장하지 않는다.
  await expect(page.getByLabel('비밀번호')).toHaveValue('');

  await page.getByLabel('아이디 저장').uncheck();
  await page.reload();
  await expect(page.getByLabel('이메일')).toHaveValue('');
  await expect(page.getByLabel('아이디 저장')).not.toBeChecked();
});
