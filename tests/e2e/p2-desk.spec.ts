import { expect, test, type Page } from '@playwright/test';
import { E2E_INGEST_SITE } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 데이터: globalSetup이 E2E_INGEST_SITE(SIM-B) 최근 2일을 적재했다 (6시간 단절 후 백필 포함). 분석 결과는 이 테스트가 만든다.

const panel = (page: Page, title: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();

/** 기술 근거는 기본으로 접혀 있다 */
const openDetails = (page: Page) => page.locator('summary', { hasText: '자세히 보기' }).click();

test('분석 데스크: SIM-B 최근 30일 분석 실행 → 바로 응답하고 다른 메뉴로 이동 → 결과 요약·실행 이력 → 인박스 또는 빈 상태 → 워크스페이스', async ({ page }) => {
  test.slow(); // 분석 실행은 롤업·에피소드 추출·탐지를 모두 한다
  await page.goto('/desk');
  const run = panel(page, '분석 실행');
  await expect(run).toContainText('리포트나 파일을 만들지 않습니다');
  for (const code of ['SIM-A', 'SIM-C', 'GP-1']) await run.getByRole('checkbox', { name: new RegExp(code) }).uncheck();
  await expect(run.getByRole('checkbox', { name: new RegExp(E2E_INGEST_SITE) })).toBeChecked();
  await expect(run.getByRole('radio', { name: '최근 30일' })).toBeChecked();

  // 분석 실행은 실행 행만 만들고 곧바로 응답한다 (계산은 서버가 응답 뒤에 잇는다)
  const posted = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/desk'));
  const clickedAt = Date.now();
  await run.getByRole('button', { name: '분석 실행' }).click();
  await posted;
  expect(Date.now() - clickedAt).toBeLessThan(3_000);
  await expect(run.getByRole('status').filter({ hasText: '시작했습니다' })).toBeVisible();
  await expect(run.getByRole('status').filter({ hasText: '진행 중' })).toBeVisible();
  // 중복 실행 차단: 진행 중에는 다시 실행할 수 없다
  await expect(run.getByRole('button', { name: '분석 실행' })).toBeDisabled();
  // 실행 뒤에도 고른 사이트·기간이 그대로다 (폼 초기화로 화면과 어긋나지 않음)
  await expect(run.getByRole('checkbox', { name: /SIM-A/ })).not.toBeChecked();

  // 실행 중에도 다른 메뉴로 옮길 수 있고, 계산은 뒤에서 계속된다
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '플릿' }).click();
  await expect(page).toHaveURL(/\/fleet$/);
  await page.goto('/desk');

  // 돌아오면 진행 표시가 이어지고, 끝나면 그 자리가 결과 요약으로 바뀐다 (이미 끝났으면 실행 이력으로 확인한다)
  const back = panel(page, '분석 실행');
  await expect(back.getByRole('button', { name: '분석 실행' })).toBeVisible();
  const status = back.getByRole('status').filter({ hasText: /진행 중|완료|일부 완료/ });
  if ((await status.count()) > 0) {
    await expect(back.getByRole('status').filter({ hasText: /완료|일부 완료/ })).toBeVisible({ timeout: 180_000 });
    await expect(back.getByText('판정 불가 탐지기')).toBeVisible();
  }

  const history = page.getByRole('region', { name: '최근 분석 실행 표' });
  await expect(history.locator('tbody tr').first()).toContainText(E2E_INGEST_SITE);
  await expect(history.locator('tbody tr').first()).toContainText(/완료|일부 완료/, { timeout: 180_000 });

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
  // 기술 요약 문단도 접힌 안쪽이다 (쉬운 요약보다 위에 남지 않는다)
  const technical = page.getByRole('region', { name: '기술 요약' });
  await expect(technical).toBeHidden();
  await openDetails(page);
  await expect(technical).toBeVisible();
  for (const title of ['효과', '원시 시계열', '원인 후보 판별']) await expect(panel(page, title)).toBeVisible();
  await expect(page.getByLabel('탐지기 신뢰 배지')).toBeVisible();
  await expect(panel(page, '활동 타임라인')).toContainText('발견사항 생성');

  // 용어 옆 물음표 → 용어집의 해당 항목
  await page.getByRole('link', { name: '원인 후보 · 플레이북 뜻 보기' }).click();
  await expect(page).toHaveURL(/\/help#playbook$/);
  await expect(page.locator('#playbook')).toContainText('원인을 가려내는 점검 방법');
});

test('화면 안내는 끄고 켤 수 있고, 용어집은 목차에서 항목으로 간다', async ({ page }) => {
  await page.goto('/desk');
  const guide = page.getByText('급한 것부터 읽고');
  await expect(guide).toBeVisible();
  await page.getByRole('button', { name: '이 화면 안내 숨기기' }).click();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button', { name: '이 화면 안내 보기' }).click();
  await expect(guide).toBeVisible();

  await page.goto('/help');
  await expect(page.getByRole('heading', { level: 1, name: '용어집' })).toBeVisible();
  await page.getByRole('link', { name: '95% 신뢰구간 (95% CI)', exact: true }).click();
  await expect(page).toHaveURL(/\/help#ci$/);
  await expect(page.locator('#ci')).toContainText('참값이 들어 있을 만한 범위');
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
