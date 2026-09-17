import { expect, test, type Page, type Route } from '@playwright/test';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 로컬 테스트 DB는 응답이 빨라 골격이 한두 프레임만 스쳐 지나간다. 시간으로 잡지 않고
// (1) 서버가 보낸 순서(골격 → 내용)를 응답 본문에서 확인하고,
// (2) 화면에는 MutationObserver로 "골격이 내용보다 먼저 있었는지"를 기록해 확인한다.

const LOADING_TEXT = '화면을 불러오는 중입니다';
const PREFETCH_HEADER = 'next-router-prefetch';

/** 골격이 처음 보인 순간의 기록 */
interface LoadingRecord {
  seen: boolean;
  skeletonBlocks: number;
}

declare global {
  interface Window {
    __consoleLoading?: LoadingRecord;
  }
}

/** 화면을 열기 전에 건다: #main에 골격(상태 문구)이 나타난 첫 순간을 붙잡는다 */
async function watchForSkeleton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: LoadingRecord = { seen: false, skeletonBlocks: 0 };
    window.__consoleLoading = record;
    const observer = new MutationObserver(() => {
      if (record.seen) return;
      const main = document.getElementById('main');
      if (main?.querySelector('[role="status"]') == null) return;
      record.seen = true;
      record.skeletonBlocks = main.querySelectorAll('div[aria-hidden="true"][class*="animate-pulse"]').length;
    });
    // document를 관찰한다: 이 스크립트는 문서가 열리기 전에 돌아 documentElement가 아직 없을 수 있다
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** content: 그 화면에서 가장 늦게 채워지는 영역의 표시 (Suspense 경계 안에서 서버가 보낸 것) */
const SLOW_SCREENS = [
  { href: '/', title: '오늘', content: { role: 'heading', name: '사이트별 발전·수소 요약' } },
  { href: '/fleet', title: '플릿', content: { role: 'group', name: '보기 전환' } },
  { href: '/desk', title: '분석 데스크', content: { role: 'heading', name: '발견사항 인박스' } },
] as const;

for (const screen of SLOW_SCREENS) {
  test(`${screen.title} 응답은 골격을 먼저 보내고 내용을 나중에 채운다`, async ({ page }) => {
    const response = await page.request.get(screen.href);
    expect(response.status()).toBe(200);
    const body = await response.text();

    const loadingAt = body.indexOf(LOADING_TEXT);
    const contentAt = body.indexOf(screen.content.name);
    expect(loadingAt, '골격이 응답에 없습니다').toBeGreaterThanOrEqual(0);
    expect(contentAt, '내용이 응답에 없습니다').toBeGreaterThanOrEqual(0);
    expect(contentAt, '내용이 골격보다 먼저 왔습니다 (스트리밍이 끊겼습니다)').toBeGreaterThan(loadingAt);
  });

  test(`${screen.title}를 열면 그 화면 골격이 먼저 보이고 내용으로 바뀐다`, async ({ page }) => {
    await watchForSkeleton(page);
    await page.goto(screen.href);

    await expect(page.getByRole(screen.content.role, { name: screen.content.name, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.title);
    await expect(page.getByText(LOADING_TEXT)).toHaveCount(0);

    const record = await page.evaluate(() => window.__consoleLoading);
    expect(record?.seen, '내용보다 먼저 골격이 보여야 합니다').toBe(true);
    expect(record?.skeletonBlocks ?? 0, '골격에 회색 블록이 있어야 합니다').toBeGreaterThan(0);
  });
}

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
