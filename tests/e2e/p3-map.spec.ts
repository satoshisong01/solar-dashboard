import { expect, test, type Page } from '@playwright/test';
import { installKakaoMapStub } from './kakao-stub';

// 지도 SDK는 tests/e2e/kakao-stub.ts로 대신한다 (playwright.config.ts가 카카오 CDN을 막는다).
// 데이터는 globalSetup이 만든 사이트 5곳(가상 SIM-A/B/C/D + 실사이트 GP-1)이고, 열린 발견사항 수는 앞선 테스트에 따라 달라지므로
// 건수 자체가 아니라 "상태대로 그려지는가·고르면 따라오는가"를 본다.

const SITE_COUNT = 5;
/** 시드한 사이트 코드 (가상 3곳 + 가평) */
const SITE_CODE = /(GP-1|SIM-[A-Z])/;
/** 마커 링크의 접근성 이름은 '… · 사이트 화면 열기'로 끝난다 (상세 패널의 같은 이름 버튼과 구분된다) */
const MARKER_NAME = /· 사이트 화면 열기$/;

const markers = (page: Page) => page.getByRole('link', { name: MARKER_NAME });
const detailPanel = (page: Page) => page.getByRole('complementary', { name: '선택한 발전소' });
const siteList = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: '사이트 × 도메인 상태' }) }).getByRole('button', { name: /마지막 수신/ });

async function openFleetMap(page: Page): Promise<void> {
  await page.goto('/fleet');
  await page.getByRole('button', { name: '지도' }).click();
  await expect(markers(page)).toHaveCount(SITE_COUNT);
}

test.describe('지도', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installKakaoMapStub);
  });

  test('플릿 지도에 사이트 5곳이 마커로 그려지고, 상단 요약이 수준별 건수를 보여 준다', async ({ page }) => {
    await openFleetMap(page);

    // 왼쪽 위 상태 칩
    await expect(page.getByText('전체 상태')).toBeVisible();
    await expect(page.getByText('열린 발견사항', { exact: true })).toBeVisible();

    // '바로 확인 N · 주의 N · 정상 N · 수신 없음 N' — 네 수준의 합은 사이트 수와 같다
    const summary = page.getByRole('list', { name: '상태 요약' }).getByRole('listitem');
    await expect(summary).toHaveCount(4);
    await expect(summary).toHaveText([/^바로 확인/, /^주의/, /^정상/, /^수신 없음/]);
    const totals = await summary.allInnerTexts();
    const sum = totals.map((text) => Number(text.replace(/\D/g, ''))).reduce((total, value) => total + value, 0);
    expect(sum).toBe(SITE_COUNT);

    // 목록도 같은 5곳이고, 각 항목에 상태와 마지막 수신이 적혀 있다
    await expect(siteList(page)).toHaveCount(SITE_COUNT);
  });

  test('목록에서 고르면 그 발전소가 상세 패널에 열리고 수치 타일 4개와 진단 한 줄이 보인다', async ({ page }) => {
    await openFleetMap(page);

    // 처음 열리면 가장 급한 곳(목록 첫 줄)이 열려 있다. 두 번째를 고르면 상세가 그 발전소로 바뀐다.
    const second = siteList(page).nth(1);
    const code = SITE_CODE.exec(await second.innerText())?.[1];
    expect(code).toBeTruthy();

    const panel = detailPanel(page);
    await expect(panel).not.toContainText(String(code));
    await second.click();
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(panel).toContainText(String(code));

    // 타일 4개는 값이거나 '해당 없음'·'데이터 없음'이다 (0으로 꾸미지 않는다)
    await expect(panel.getByText('계통 수출')).toBeVisible();
    await expect(panel.getByText('자가 소비')).toBeVisible();
    await expect(panel.getByText('AI 진단 리포트')).toBeVisible();
    await expect(panel.getByText(/현재 특이사항 없음|습니다\.$/)).toBeVisible();
  });

  test('마커를 누르면 그 사이트 화면으로 간다', async ({ page }) => {
    await openFleetMap(page);

    const marker = markers(page).first();
    const label = (await marker.getAttribute('aria-label')) ?? '';
    const code = SITE_CODE.exec(label)?.[1];
    expect(code).toBeTruthy();

    await marker.click();
    await expect(page).toHaveURL(new RegExp(`/sites/${code}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(String(code));
  });

  test('대시보드의 지도 카드에 마커가 보이고 전체 보기로 플릿에 간다', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('section', { has: page.getByRole('heading', { name: '발전소 지도', exact: true }) });
    await expect(card.getByRole('link', { name: MARKER_NAME })).toHaveCount(SITE_COUNT);

    await card.getByRole('button', { name: '지도 접기' }).click();
    await expect(card.getByRole('link', { name: MARKER_NAME }).first()).toBeHidden();

    await card.getByRole('link', { name: '지도 전체 보기' }).click();
    await expect(page).toHaveURL(/\/fleet$/);
  });
});

test('지도를 불러오지 못하면 안내와 함께 목록·상세만 남는다 (지도 키가 없을 때와 같은 대체 화면)', async ({ page }) => {
  // 스텁을 넣지 않는다: 카카오 CDN이 막혀 있어 SDK 로딩이 실패한다
  await page.goto('/fleet');
  await page.getByRole('button', { name: '지도' }).click();

  // Next의 경로 안내(route announcer)도 role=alert이라 문구로 좁힌다
  await expect(page.getByRole('alert').filter({ hasText: '지도를 불러오지 못했습니다' })).toBeVisible();
  await expect(siteList(page)).toHaveCount(SITE_COUNT);
  await expect(detailPanel(page)).toBeVisible();
  await expect(page.getByRole('link', { name: MARKER_NAME })).toHaveCount(0);
});
