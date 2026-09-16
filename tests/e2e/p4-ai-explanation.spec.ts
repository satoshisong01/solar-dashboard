import { expect, test, type Page } from '@playwright/test';

// AI 설명(과제 4). E2E 환경에는 GEMINI_API_KEY가 없다 —
// 그래서 여기서 확인하는 것은 "키가 없어도 화면이 그대로 돌아가고, 규칙 기반 요약으로 안전하게 되돌아간다"는 쪽이다.
// 실제 생성·검증 경로는 unit(lib/llm)과 integration(tests/integration/ai-explanation.test.ts)이 가짜 제공자로 덮는다.

const globalForm = (page: Page) => page.locator('form', { has: page.getByLabel('전역 기본값') });
const firstSiteForm = (page: Page) => page.locator('form', { has: page.locator('input[name="siteId"]') }).first();

test('AI 설명 설정: 키가 없다고 알리고, 전역·사이트별로 끄고 켤 수 있다', async ({ page }) => {
  await page.goto('/settings/ai');
  await expect(page.getByRole('link', { name: 'AI 설명' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('GEMINI_API_KEY 없음')).toBeVisible();
  await expect(page.getByText('판정과 수치는 언제나 분석 엔진 값')).toBeVisible();

  const form = globalForm(page);
  await form.getByLabel('전역 기본값').selectOption('off');
  await form.getByRole('button', { name: '저장' }).click();
  await expect(form.getByRole('status')).toContainText('사용 안 함');

  await page.reload();
  await expect(globalForm(page).getByLabel('전역 기본값')).toHaveValue('off');

  // 사이트 설정은 전역보다 앞선다 (켰다가 다시 전역 따름으로 되돌린다)
  const site = firstSiteForm(page);
  await site.locator('select[name="enabled"]').selectOption('on');
  await site.getByRole('button', { name: '저장' }).click();
  await expect(site.getByRole('status')).toContainText('사용');

  await site.locator('select[name="enabled"]').selectOption('inherit');
  await site.getByRole('button', { name: '저장' }).click();
  await expect(site.getByRole('status')).toContainText('전역 따름');
});

test('워크스페이스 쉬운 요약: 출처 배지와 다시 생성 버튼, 키가 없으면 규칙 기반 요약 그대로', async ({ page }) => {
  await page.goto('/desk?status=all');
  const links = page.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr a');
  test.skip((await links.count()) === 0, '앞선 분석에서 발견사항이 나오지 않았습니다');

  await links.first().click();
  await expect(page).toHaveURL(/\/desk\/\d+$/);
  const plain = page.getByRole('region', { name: '쉬운 요약' });
  await expect(plain).toContainText('규칙 기반 요약');
  const headline = (await plain.locator('p').first().innerText()).trim();
  expect(headline).not.toBe('');

  await plain.getByRole('button', { name: '다시 생성' }).click();
  // 키가 없으니 만들지 못하고, 문장은 규칙 기반 요약 그대로다 (화면이 깨지지 않는다)
  await expect(plain.getByRole('alert')).toContainText('규칙 기반 요약을 그대로 둡니다');
  await expect(plain).toContainText('규칙 기반 요약');
  await expect(plain.getByText(headline, { exact: true })).toBeVisible();
});
