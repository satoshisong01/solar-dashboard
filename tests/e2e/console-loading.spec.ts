import { expect, test, type Page, type Route } from '@playwright/test';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 로컬 테스트 DB는 응답이 빨라 로딩 표시가 한두 프레임만 스쳐 지나간다. 시간으로 잡지 않고
// (1) 서버가 보낸 순서(로딩 → 내용)를 응답 본문에서 확인하고,
// (2) 화면에는 MutationObserver로 "로딩 표시가 내용보다 먼저 있었는지"를 기록해 확인한다.

const LOADING_TEXT = '불러오는 중';
const PREFETCH_HEADER = 'next-router-prefetch';

/** 로딩 표시가 처음 보인 순간의 기록 */
interface LoadingRecord {
  seen: boolean;
  spinners: number;
}

declare global {
  interface Window {
    __consoleLoading?: LoadingRecord;
  }
}

/** 화면을 열기 전에 건다: #main에 로딩 표시(role=status)가 나타난 첫 순간을 붙잡는다 */
async function watchForLoading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: LoadingRecord = { seen: false, spinners: 0 };
    window.__consoleLoading = record;
    const observer = new MutationObserver(() => {
      if (record.seen) return;
      const main = document.getElementById('main');
      if (main?.querySelector('[role="status"]') == null) return;
      record.seen = true;
      record.spinners = main.querySelectorAll('svg[class*="animate-spin"]').length;
    });
    // document를 관찰한다: 이 스크립트는 문서가 열리기 전에 돌아 documentElement가 아직 없을 수 있다
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** content: 그 화면에서 가장 늦게 채워지는 영역의 표시 (Suspense 경계 안에서 서버가 보낸 것) */
const SLOW_SCREENS = [
  { href: '/', title: '대시보드', content: { role: 'heading', name: '사이트별 발전·수소 요약' } },
  { href: '/fleet', title: '플릿', content: { role: 'group', name: '보기 전환' } },
  { href: '/desk', title: '분석 데스크', content: { role: 'heading', name: '발견사항 인박스' } },
] as const;

for (const screen of SLOW_SCREENS) {
  test(`${screen.title} 응답은 로딩 표시를 먼저 보내고 내용을 나중에 채운다`, async ({ page }) => {
    const response = await page.request.get(screen.href);
    expect(response.status()).toBe(200);
    const body = await response.text();

    const loadingAt = body.indexOf(LOADING_TEXT);
    const contentAt = body.indexOf(screen.content.name);
    expect(loadingAt, '로딩 표시가 응답에 없습니다').toBeGreaterThanOrEqual(0);
    expect(contentAt, '내용이 응답에 없습니다').toBeGreaterThanOrEqual(0);
    expect(contentAt, '내용이 로딩 표시보다 먼저 왔습니다 (스트리밍이 끊겼습니다)').toBeGreaterThan(loadingAt);
  });

  test(`${screen.title}를 열면 로딩 표시가 먼저 보이고 내용으로 바뀐다`, async ({ page }) => {
    await watchForLoading(page);
    await page.goto(screen.href);

    await expect(page.getByRole(screen.content.role, { name: screen.content.name, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.title);
    await expect(page.getByText(LOADING_TEXT)).toHaveCount(0);

    const record = await page.evaluate(() => window.__consoleLoading);
    expect(record?.seen, '내용보다 먼저 로딩 표시가 보여야 합니다').toBe(true);
    expect(record?.spinners ?? 0, '로딩 표시에 스피너가 있어야 합니다').toBeGreaterThan(0);
  });
}

test('화면을 기다리는 동안 눈에 보이는 진행 배지가 뜬다 (회색 칸만으로는 빈 화면과 구별되지 않는다)', async ({ page }) => {
  await page.route('**/*', async (route: Route) => {
    if (route.request().headers()[PREFETCH_HEADER] === '1') return route.abort();
    if (new URL(route.request().url()).pathname === '/settings/detectors') await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.continue();
  });
  await page.goto('/settings/admins');

  const badge = page.getByText('불러오는 중', { exact: true }).first();
  await expect(badge).toHaveCount(0);

  await page.getByRole('link', { name: '탐지기', exact: true }).click();
  await expect(badge).toBeVisible();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('설정');
  await expect(badge).toHaveCount(0);
});

test('표의 링크로 다른 화면에 갈 때도 배지가 뜬다 (경계를 넘는 이동)', async ({ page }) => {
  await page.route('**/*', async (route: Route) => {
    if (route.request().headers()[PREFETCH_HEADER] === '1') return route.abort();
    if (new URL(route.request().url()).pathname.startsWith('/sites/')) await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.continue();
  });
  await page.goto('/sites');

  const badge = page.getByText('불러오는 중', { exact: true }).first();
  await expect(badge).toHaveCount(0);

  await page.getByRole('link', { name: /SIM-B/ }).first().click();
  await expect(badge).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('사이트');
});

test('같은 화면에서 쿼리만 바꿔도 배지가 뜬다 (골격이 뜨지 않는 이동)', async ({ page }) => {
  await page.route('**/*', async (route: Route) => {
    if (route.request().headers()[PREFETCH_HEADER] === '1') return route.abort();
    const url = new URL(route.request().url());
    if (url.pathname === '/explore' && url.search !== '') await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.continue();
  });
  await page.goto('/explore');

  const badge = page.getByText('불러오는 중', { exact: true }).first();
  await expect(badge).toHaveCount(0);

  await page.getByRole('group', { name: '기간' }).getByRole('link', { name: '7일' }).click();
  await expect(badge).toBeVisible();
});

test('필터 폼을 적용할 때도 배지가 뜬다 (GET 제출은 문서 전체가 다시 로드된다)', async ({ page }) => {
  await page.route('**/*', async (route: Route) => {
    if (route.request().headers()[PREFETCH_HEADER] === '1') return route.abort();
    const url = new URL(route.request().url());
    if (url.pathname === '/desk' && url.search !== '') await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.continue();
  });
  await page.goto('/desk');

  const badge = page.getByText('불러오는 중', { exact: true }).first();
  await expect(badge).toHaveCount(0);

  await page.getByRole('form', { name: '발견사항 필터' }).getByRole('button', { name: '적용' }).click();
  await expect(badge).toBeVisible();
});

test('prefetch가 없을 때 메뉴를 누르면 그 항목에 대기 표시(aria-busy)가 붙고 다시 눌리지 않는다', async ({ page }) => {
  // prefetch를 막고 본 요청을 늦춰, 클릭 뒤 실제로 서버를 기다리는 상황을 만든다
  await page.route('**/*', async (route: Route) => {
    if (route.request().headers()[PREFETCH_HEADER] === '1') return route.abort();
    if (new URL(route.request().url()).pathname === '/fleet') await new Promise((resolve) => setTimeout(resolve, 1200));
    return route.continue();
  });
  await page.goto('/help');

  const link = page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '플릿', exact: true });
  await link.click();

  await expect(link).toHaveAttribute('aria-busy', 'true');
  // 대기 중에는 포인터 이벤트를 막아 두 번 눌리지 않는다
  await expect(link).toHaveCSS('pointer-events', 'none');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('플릿');
  await expect(link).not.toHaveAttribute('aria-busy', 'true');
});
