import { expect, test, type Locator, type Page } from '@playwright/test';

// 공정도(P&ID) 화면. 데이터는 앞 단계가 만든 것을 그대로 쓴다 (serial):
//   GP-1  실사이트 — 계장 태그 10점이 시드에 있고 준공 전이라 수신이 없다 → '데이터 없음'으로 보여야 한다
//   SIM-B 가상 사이트 — globalSetup이 최근 2일을 적재했다. 산소·폐열·감압 계통이 없어 그 상자는 '해당 없음'이다
//   SIM-A 태양광+ESS — 수전해가 없어 '공정도 없음'
// 스크린샷은 Playwright 산출물 폴더(test-results/)에 남긴다.

const panel = (page: Page, title: string): Locator =>
  page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
const assetTable = (page: Page): Locator => page.getByRole('region', { name: '공정도 설비 목록 표' });
const tagTable = (page: Page): Locator => page.getByRole('region', { name: '공정도 계장 태그 표' });

/** 도면에 그려진 계장 10점 */
const DRAWING_TAGS = ['LT-101', 'FT-101', 'TT-303', 'TT-302', 'TT-301', 'PT-401', 'PT-201', 'FT-201', 'PT-202', 'FT-301'];

test('사이트 상세에서 공정도로 간다', async ({ page }) => {
  await page.goto('/sites/GP-1');
  await page.getByRole('link', { name: '공정도 (P&ID)' }).click();
  await expect(page).toHaveURL(/\/sites\/GP-1\/diagram$/);
  await expect(page.getByRole('heading', { level: 1, name: 'GP-1 · 공정도' })).toBeVisible();
});

test('(1) 가평 공정도: 도면 설비·계장 태그가 그려지고, 수신이 없으면 값 자리는 데이터 없음', async ({ page }) => {
  await page.goto('/sites/GP-1/diagram');

  // 도면 표제란을 그대로 적는다
  await expect(page.getByText('FCND-GP-PID-002 REV.2')).toBeVisible();

  // 그림 자체 (SVG)
  const figure = page.getByRole('img', { name: /공정흐름 계장도$/ });
  await expect(figure).toBeVisible();
  // 도면 상자 15개가 모두 그려진다 (가평은 도면의 모든 계통을 시드했다)
  await expect(figure.locator('[data-node-id]')).toHaveCount(15);
  await expect(figure.locator('[data-tag]')).toHaveCount(DRAWING_TAGS.length);
  // 흐름선 범례 (도면 LINE LEGEND)
  await expect(page.getByText('폐열 온수 75 °C', { exact: true })).toBeVisible();

  // 계장 태그 표: 10점 전부, 시드가 넣은 포인트에 이어져 있고 값은 아직 없다
  const tagRows = tagTable(page).locator('tbody tr');
  await expect(tagRows).toHaveCount(DRAWING_TAGS.length);
  for (const tag of DRAWING_TAGS) await expect(tagRows.filter({ hasText: tag })).toHaveCount(1);
  await expect(tagRows.filter({ hasText: 'PT-201' })).toContainText('H2BUF1 / h2.pressure@buffer');
  await expect(tagRows.filter({ hasText: 'PT-201' })).toContainText('데이터 없음');

  // 명판은 도면 값 그대로 (미확인 명판은 숫자를 지어내지 않는다)
  const elzRow = assetTable(page).locator('tbody tr').filter({ hasText: 'PEM 수전해 설비' });
  await expect(elzRow).toContainText('2,500 kW');
  await expect(elzRow).toContainText('44.9 kg/h');
  await expect(elzRow).toContainText('수신 기록 없음');

  await page.screenshot({ path: test.info().outputPath('gp1-diagram.png'), fullPage: true });
});

test('(2) 구성이 다른 사이트는 있는 계통만 그리고 나머지는 해당 없음, 값은 실제 수신값', async ({ page }) => {
  await page.goto('/sites/SIM-B/diagram');
  const rows = assetTable(page).locator('tbody tr');
  await expect(rows).toHaveCount(15);

  // 산소·폐열·감압·반입 계통은 SIM-B에 없다
  for (const name of ['부산물 산소 계통', '폐열회수 열교환기 HX-301', '수소 감압밸브 스키드', '외부 수소 반입 설비']) {
    await expect(rows.filter({ hasText: name })).toContainText('해당 없음');
  }
  // 없는 상자에 걸린 계장 태그는 그리지 않는다 (산소 압력 PT-401·감압 후 PT-202)
  const tagRows = tagTable(page).locator('tbody tr');
  await expect(tagRows.filter({ hasText: 'PT-401' })).toHaveCount(0);
  await expect(tagRows.filter({ hasText: 'PT-201' })).toHaveCount(1);

  // 적재된 값이 단위와 함께 보인다
  await expect(tagRows.filter({ hasText: 'FT-201' })).toContainText(/\d\s*kg\/h/);
  await expect(panel(page, '공정흐름 · 계장도')).toContainText('값 갱신');

  await page.screenshot({ path: test.info().outputPath('sim-b-diagram.png'), fullPage: true });
});

test('(3) 수전해가 없는 사이트는 공정도 없음', async ({ page }) => {
  await page.goto('/sites/SIM-A/diagram');
  await expect(page.getByRole('heading', { level: 2, name: '공정도 없음' })).toBeVisible();
  await expect(page.getByText('수전해 설비가 없어')).toBeVisible();
  await expect(page.getByRole('img', { name: /공정흐름 계장도$/ })).toHaveCount(0);
});

test('(4) 열린 발견사항이 있는 설비는 강조되고 눌러서 그 발견사항으로 간다', async ({ page }) => {
  await page.goto('/sites/SIM-B/diagram');
  const findingLinks = assetTable(page).getByRole('link', { name: /건 보기$/ });
  test.skip((await findingLinks.count()) === 0, '앞선 분석에서 SIM-B 발견사항이 나오지 않았습니다');

  // 그림 쪽도 같은 상자를 강조한다 (색만이 아니라 배지 숫자와 접근성 이름으로도 알린다)
  const figure = page.getByRole('img', { name: /공정흐름 계장도$/ });
  await expect(figure.locator('[data-level="critical"], [data-level="warning"]').first()).toBeVisible();
  await expect(figure.getByRole('link', { name: /열린 발견사항 \d+건/ }).first()).toBeVisible();

  await findingLinks.first().click();
  await expect(page).toHaveURL(/\/desk\/\d+$/);
});

test('(5) 좁은 화면: 페이지는 넘치지 않고 그림만 가로로 스크롤되며 설비 목록 표가 그림을 대신한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/sites/SIM-B/diagram');

  const figureRegion = page.getByRole('region', { name: /^공정도 그림/ });
  await expect(figureRegion).toBeVisible();
  // 그림 영역은 자기 안에서 가로로 넘치고, 페이지 자체는 넘치지 않는다
  const scroll = await figureRegion.evaluate((el) => ({ inner: el.scrollWidth - el.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(scroll.inner).toBeGreaterThan(0);
  expect(scroll.page).toBeLessThanOrEqual(1);

  await expect(assetTable(page).locator('tbody tr')).toHaveCount(15);
  await page.screenshot({ path: test.info().outputPath('sim-b-diagram-narrow.png'), fullPage: true });
});
