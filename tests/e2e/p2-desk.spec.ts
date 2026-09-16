import { expect, test, type Page } from '@playwright/test';
import { E2E_INGEST_SITE } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 데이터: globalSetup이 E2E_INGEST_SITE(SIM-B) 최근 2일을 적재했다 (6시간 단절 후 백필 포함). 분석 결과는 이 테스트가 만든다.

const panel = (page: Page, title: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();

/** 기술 근거는 기본으로 접혀 있다 */
const openDetails = (page: Page) => page.locator('summary', { hasText: '자세히 보기' }).click();

test('분석 데스크: SIM-B 최근 30일 분석 실행 → 결과 요약·실행 이력 → 인박스 또는 빈 상태 → 워크스페이스', async ({ page }) => {
  test.slow(); // 분석 실행은 롤업·에피소드 추출·탐지를 모두 한다
  await page.goto('/desk');
  const run = panel(page, '분석 실행');
  await expect(run).toContainText('리포트나 파일을 만들지 않습니다');
  for (const code of ['SIM-A', 'SIM-C']) await run.getByRole('checkbox', { name: new RegExp(code) }).uncheck();
  await expect(run.getByRole('checkbox', { name: new RegExp(E2E_INGEST_SITE) })).toBeChecked();
  await expect(run.getByRole('radio', { name: '최근 30일' })).toBeChecked();

  await run.getByRole('button', { name: '분석 실행' }).click();
  await expect(run.getByRole('button', { name: '분석 중…' })).toBeDisabled();
  await expect(run.getByRole('status').filter({ hasText: '마쳤습니다' })).toBeVisible({ timeout: 180_000 });
  await expect(run.getByText('판정 불가 탐지기')).toBeVisible();
  // 실행 뒤에도 고른 사이트·기간이 그대로다 (폼 초기화로 화면과 어긋나지 않음)
  await expect(run.getByRole('checkbox', { name: /SIM-A/ })).not.toBeChecked();

  const history = page.getByRole('region', { name: '최근 분석 실행 표' });
  await expect(history.locator('tbody tr').first()).toContainText(E2E_INGEST_SITE);
  await expect(history.locator('tbody tr').first()).toContainText(/완료|일부 완료/);

  await page.goto('/desk?status=all');
  const inbox = panel(page, '발견사항 인박스');
  const links = inbox.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr a');
  if ((await links.count()) === 0) {
    await expect(inbox.getByText('아직 발견사항이 없습니다')).toBeVisible();
    return;
  }
  // 인박스 행에 쉬운 말 한 줄 요약과 급함을 말로 쓴 칩이 있다
  const firstRow = inbox.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr').first();
  await expect(firstRow).toContainText('니다.');
  await expect(firstRow).toContainText(/바로 확인|이번 주 확인|지켜보기|참고/);

  await links.first().click();
  await expect(page).toHaveURL(/\/desk\/\d+$/);
  // 맨 위는 쉬운 요약 4줄, 기술 근거는 '자세히 보기'를 열어야 보인다
  const plain = page.getByRole('region', { name: '쉬운 요약' });
  await expect(plain).toBeVisible();
  for (const label of ['어떻게 확인했나', '왜 문제인가', '지금 할 일']) await expect(plain).toContainText(label);
  await expect(panel(page, '활동 타임라인')).toBeVisible();
  await expect(panel(page, '효과')).toBeHidden();
  await openDetails(page);
  for (const title of ['효과', '원시 시계열', '원인 후보 판별']) await expect(panel(page, title)).toBeVisible();
  await expect(page.getByLabel('탐지기 신뢰 배지')).toBeVisible();
  await expect(panel(page, '활동 타임라인')).toContainText('발견사항 생성');
});

test('없는 발견사항 id는 찾을 수 없음 화면', async ({ page }) => {
  await page.goto('/desk/999999999');
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible();
});

test('HYSOL_SHOW_SIM 없이는 시뮬레이터 메뉴가 없고 /sim은 찾을 수 없음', async ({ page }) => {
  await page.goto('/sim');
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '시뮬레이터' })).toHaveCount(0);
});

test('오늘 화면에 할 일 카운터와 신규·악화 발견사항 영역이 있다', async ({ page }) => {
  await page.goto('/');
  const work = panel(page, '할 일');
  for (const label of ['새 발견사항', '조사 중', '조치 후 검증 대기', '검증 결과 도착']) await expect(work.getByRole('link', { name: new RegExp(label) })).toBeVisible();
  await expect(panel(page, '신규·악화 발견사항')).toBeVisible();
});
