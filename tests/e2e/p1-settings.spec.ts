import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E_BASE_URL, SIGNED_OUT } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const kstDate = (ms: number): string => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

test('시장가격 CSV: 오류 행을 행 번호와 함께 안내하고, 올바른 파일을 적용하면 오늘 화면 수익 요약에 반영된다', async ({ page }) => {
  const today = kstDate(Date.now());
  const yesterday = kstDate(Date.now() - DAY_MS);
  await page.goto('/settings/market');
  const fileInput = page.getByLabel(/CSV 파일/);

  const badCsv = ['day,market_key,value', `${yesterday},smp_land,140.1`, '2026-02-30,smp_land,1', `${today},smp_mainland,2`, `${yesterday},smp_land,141`].join('\n');
  await fileInput.setInputFiles({ name: 'market-bad.csv', mimeType: 'text/csv', buffer: Buffer.from(badCsv) });
  const errors = page.getByRole('alert').filter({ hasText: '오류가 있는 행' });
  await expect(errors).toContainText('3행: day: 달력에 없는 날짜입니다');
  await expect(errors).toContainText('4행: market_key는');
  await expect(errors).toContainText('5행: 2행과 날짜·항목이 겹칩니다');
  await expect(page.getByRole('button', { name: '1행 적용' })).toBeDisabled();

  // BOM·CRLF·따옴표 값이 섞인 올바른 파일
  const goodCsv = [
    'day,market_key,value',
    `${yesterday},smp_land,150.25`,
    `${yesterday},smp_jeju,"133.5"`,
    `${yesterday},rec_avg,71500`,
    `${today},smp_land,151.75`,
    `${today},smp_jeju,"134.5"`,
    `${today},rec_avg,72350`,
  ].join('\r\n');
  await fileInput.setInputFiles({ name: 'market-good.csv', mimeType: 'text/csv', buffer: Buffer.from(`﻿${goodCsv}`) });
  await expect(errors).toHaveCount(0);
  await page.getByRole('button', { name: '6행 적용' }).click();
  await expect(page.getByRole('status').filter({ hasText: '저장했습니다. 새로 6건, 덮어씀 0건' })).toBeVisible();

  await page.goto('/');
  const revenue = page.locator('section', { has: page.getByRole('heading', { name: '수익 요약', exact: true }) });
  const card = (label: string) => revenue.locator('div', { has: page.getByText(label, { exact: true }) });
  await expect(card('SMP (육지)')).toContainText('151.75');
  await expect(card('SMP (제주)')).toContainText('134.5');
  await expect(card('REC 평균')).toContainText('72,350');
  await expect(card('SMP (육지)')).toContainText(`최근 입력 ${today}`);
});

test('게이트웨이 키: 비밀값은 발급 직후 한 번만 보이고, 화면에 다시 들어오면 보이지 않는다', async ({ page }) => {
  const gatewayCode = 'GW-E2E-01';
  await page.goto('/settings/gateways');
  const siteSelect = page.getByLabel('사이트', { exact: true });
  await siteSelect.selectOption((await siteSelect.locator('option').filter({ hasText: /^SIM-C · / }).getAttribute('value')) ?? '');
  await page.getByLabel('게이트웨이 코드').fill(gatewayCode);
  await page.getByRole('button', { name: '게이트웨이 만들기' }).click();
  await expect(page.getByRole('status').filter({ hasText: `게이트웨이 ${gatewayCode}를 만들었습니다` })).toBeVisible();

  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: new RegExp(gatewayCode) }) });
  await expect(card.getByText('발급된 키가 없어')).toBeVisible();
  await card.getByRole('button', { name: '새 키 발급' }).click();
  await expect(card.getByText('비밀값은 지금 한 번만 표시됩니다.')).toBeVisible();
  const issued = card.getByRole('definition'); // [키 ID, 비밀값]
  const keyId = (await issued.nth(0).textContent()) ?? '';
  const secret = (await issued.nth(1).textContent()) ?? '';
  expect(keyId).toMatch(/^gk_/);
  expect(secret.length).toBeGreaterThanOrEqual(43);

  // 다른 화면에 갔다가 다시 들어온다: 키 ID는 목록에 남고 비밀값은 어디에도 없다
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '오늘', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/settings/gateways');
  const revisited = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: new RegExp(gatewayCode) }) });
  await expect(revisited.getByText(keyId, { exact: true })).toBeVisible();
  await expect(page.getByText('비밀값은 지금 한 번만 표시됩니다.')).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);
  const html = await (await page.request.get('/settings/gateways')).text(); // RSC 페이로드 포함
  expect(html).toContain(keyId);
  expect(html).not.toContain(secret);
});

/** 로그인 rate limit(10초에 3회)에 걸리면 창이 지날 때까지 다시 시도한다. 429 응답은 카운트를 늘리지 않는다 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  let status = 0;
  await expect(async () => {
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(password);
    const response = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/auth/sign-in/email');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    status = (await response).status();
    expect(status, '로그인 rate limit').not.toBe(429);
  }).toPass({ intervals: [1_000, 2_000, 4_000], timeout: 30_000 });
  expect(status).toBe(200);
}

test('관리자 계정을 만들면 새 계정으로 로그인해 오늘 화면에 들어간다', async ({ page, browser }) => {
  // 실행마다 다른 계정. 공유 관리자 세션을 바꾸지 않도록 로그인은 별도 브라우저 컨텍스트에서 한다.
  const email = `e2e-new-admin-${Date.now()}@hysol.local`;
  const password = randomBytes(18).toString('base64url');
  await page.goto('/settings/admins');
  const form = page.locator('form', { has: page.getByRole('button', { name: '관리자 만들기' }) });
  await form.getByLabel('이메일').fill(email);
  await form.getByLabel('이름').fill('E2E 신규 관리자');
  await form.getByLabel('임시 비밀번호').fill(password);
  await form.getByRole('button', { name: '관리자 만들기' }).click();
  await expect(page.getByRole('status').filter({ hasText: `관리자 ${email} 계정을 만들었습니다` })).toBeVisible();
  await expect(page.getByRole('region', { name: '계정 표' })).toContainText(email);

  const context = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: SIGNED_OUT });
  try {
    const newPage = await context.newPage();
    await signIn(newPage, email, password);
    await expect(newPage).toHaveURL('/');
    await expect(newPage.getByRole('heading', { level: 1, name: '오늘' })).toBeVisible();
  } finally {
    await context.close();
  }
});
