import { expect, test, type Page, type Response } from '@playwright/test';
import { LOOP_SITE } from './closed-loop-plan';
import { E2E_BASE_URL, E2E_INGEST_SITE, SIGNED_OUT } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 데이터: globalSetup이 E2E_INGEST_SITE(SIM-B) 최근 2일을 실제 수집 API로 적재했고, SIM-A는 폐루프 픽스처(과거 80일)만 있고, SIM-C는 수신 기록이 없다.

const SITE_CODES = ['SIM-A', 'SIM-B', 'SIM-C'];
/** lib/data/fleet-status.ts의 신선도 사유 문구 */
const FRESHNESS_REASON = /수신 끊김|수신 지연|수신 기록 없음/;
const STACK_NAME = '전해 스택 1';
const HOUR_MS = 3_600_000;

type SeriesBody = Readonly<{ source: string; bucketSeconds: number; series: readonly Readonly<{ pointId: number; rows: readonly (readonly (number | null)[])[] }>[] }>;

const isSeriesUrl = (url: string | URL): boolean => new URL(url).pathname === '/api/series';
/** [ts, min, avg, max] 중 평균이 있는 버킷 수 */
const dataPointCount = (body: SeriesBody): number => body.series.flatMap((series) => series.rows).filter((row) => typeof row[2] === 'number').length;

async function openStackAsset(page: Page): Promise<void> {
  await page.goto(`/sites/${E2E_INGEST_SITE}`);
  // 이벤트 타임라인에도 설비 링크가 있으므로 설비 트리 안에서 고른다.
  const tree = page.locator('section', { has: page.getByRole('heading', { name: '설비 트리', exact: true }) });
  await tree.getByRole('link', { name: STACK_NAME, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sites/${E2E_INGEST_SITE}/assets/\\d+$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(STACK_NAME);
}

test('플릿 매트릭스에 사이트 3곳이 보이고, 적재한 사이트는 모든 도메인의 데이터 신선도가 정상이다', async ({ page }) => {
  await page.goto('/fleet');
  const matrix = page.getByRole('region', { name: '사이트 × 도메인 상태 매트릭스' });
  const rows = matrix.locator('tbody > tr');
  await expect(rows.getByRole('rowheader').getByRole('link')).toHaveText(SITE_CODES);

  const rowOf = (code: string) => rows.filter({ has: page.getByRole('link', { name: code, exact: true }) });
  const ingested = rowOf(E2E_INGEST_SITE);
  await expect(ingested.getByRole('cell')).toHaveCount(6); // PV·ESS·전해조·저장·연료전지·데이터품질
  await expect(ingested.getByText(FRESHNESS_REASON)).toHaveCount(0);
  await expect(ingested.getByText('데이터 없음', { exact: true })).toHaveCount(0);

  // 대조: 같은 규칙으로 적재하지 않은 SIM-C는 "수신 기록 없음", 과거 기간만 적재한 SIM-A는 "수신 끊김"이 보인다 (위 검사가 빈 화면에서 통과하는 것이 아님)
  await expect(rowOf('SIM-C').getByText('수신 기록 없음').first()).toBeVisible();
  await expect(rowOf(LOOP_SITE).getByText(/^수신 끊김/).first()).toBeVisible();
});

test('사이트 상세 → 전해 스택 → 시계열 차트 캔버스가 그려지고, 확대하면 /api/series가 200과 데이터 점을 준다', async ({ page }) => {
  await openStackAsset(page);

  const chart = page.getByRole('img', { name: /^시계열 차트:/ });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('이 기간에 수신한 데이터가 없습니다')).toHaveCount(0);

  // 첫 화면 데이터는 서버 렌더에 들어 있다. 차트를 확대(휠)하면 그 구간을 /api/series로 다시 받는다.
  const firstResponse = page.waitForResponse((response) => isSeriesUrl(response.url()));
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error('차트 영역을 찾지 못했습니다');
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45);
  await expect(async () => {
    const requested = page.waitForRequest((request) => isSeriesUrl(request.url()), { timeout: 2_000 });
    await page.mouse.wheel(0, -400);
    await requested;
  }).toPass({ timeout: 20_000 });

  const response: Response = await firstResponse;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as SeriesBody;
  expect(body.source).toBe('raw');
  expect(body.series.length).toBeGreaterThan(0);
  expect(dataPointCount(body)).toBeGreaterThan(0);
  await expect(page.getByText(/확대 구간 재조회/)).toBeVisible();
});

test('비로그인 /api/series는 데이터가 있는 포인트여도 로그인 화면으로 보내지 않고 401 JSON만 준다', async ({ page, playwright }) => {
  await openStackAsset(page);
  // 기간 버튼을 누르면 선택한 포인트가 URL(points=)에 남는다.
  await page.getByRole('group', { name: '기간' }).getByRole('link', { name: '7일', exact: true }).click();
  await expect(page).toHaveURL(/[?&]points=\d+/);
  const pointIds = new URL(page.url()).searchParams.get('points');
  const now = Date.now();
  const query = new URLSearchParams({ pointIds: pointIds ?? '', from: new Date(now - 24 * HOUR_MS).toISOString(), to: new Date(now).toISOString() });

  const authorized = await page.request.get(`/api/series?${query.toString()}`);
  expect(authorized.status()).toBe(200);
  expect(dataPointCount((await authorized.json()) as SeriesBody)).toBeGreaterThan(0);

  const anonymous = await playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: SIGNED_OUT });
  try {
    const response = await anonymous.get(`/api/series?${query.toString()}`, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  } finally {
    await anonymous.dispose();
  }
});
