import { expect, test } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_INGEST_SITE } from './e2e-env';

// chromium 프로젝트의 storageState(auth.setup.ts에서 로그인한 세션)를 쓴다.
// 데이터: globalSetup 적재에 수소 누출 1차 경보(H2_LEAK_L1, 안전 이벤트) 1건과 SIM-B 미매핑 태그 2개가 들어 있다.

const LEAK_CODE = 'H2_LEAK_L1';
const UNMAPPED_TAG = 'COMP1/VIB_RMS';

test('대시보드 안전 배너 → 안전 화면에서 메모와 함께 확인 → 이력에 남고 배너가 사라진다', async ({ page }) => {
  await page.goto('/');
  const banner = page.getByRole('region', { name: /^미확인 안전 이벤트 \d+건$/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(E2E_INGEST_SITE);
  await expect(banner).toContainText(LEAK_CODE);

  await banner.getByRole('link', { name: '안전 화면에서 확인' }).click();
  await expect(page).toHaveURL('/safety');

  const unacked = page.locator('section', { has: page.getByRole('heading', { name: '미확인 안전 이벤트', exact: true }) });
  const event = unacked.getByRole('listitem').filter({ hasText: LEAK_CODE });
  await expect(event).toHaveCount(1);
  const note = `E2E 확인: 저장뱅크 검지기 현장 점검, 오경보 (${Date.now()})`;
  await event.getByLabel(/확인 메모/).fill(note);
  await event.getByRole('button', { name: /^확인\(ack\)/ }).click();

  await expect(unacked.getByText('미확인 안전 이벤트가 없습니다')).toBeVisible();
  const history = page.getByRole('region', { name: '안전 이벤트 확인 이력 표' });
  await expect(history).toContainText(note);
  await expect(history).toContainText(E2E_ADMIN_EMAIL);
  await expect(history).toContainText(LEAK_CODE);

  await page.goto('/');
  await expect(page.getByText('미확인 안전 이벤트가 없습니다.')).toBeVisible();
  await expect(page.getByRole('region', { name: /^미확인 안전 이벤트 \d+건$/ })).toHaveCount(0);
});

test('미매핑 태그를 매핑하고 재처리하면 해당 설비 포인트 목록에 최신값이 보인다', async ({ page }) => {
  test.slow(); // 재처리는 게이트웨이의 보존 배치를 모두 다시 읽는다

  await page.goto('/data/unmapped');
  const inbox = page.getByRole('region', { name: '미매핑 태그 표' });
  await expect(inbox.getByRole('rowheader', { name: UNMAPPED_TAG, exact: true })).toBeVisible();
  await inbox.getByRole('link', { name: `매핑 — ${UNMAPPED_TAG}` }).click();
  await expect(page).toHaveURL(/\/data\/unmapped\/map\?gateway=\d+&source=COMP1%2FVIB_RMS$/);

  // 1. 포인트 매핑: 압축기 COMP1 · 진동 속도 RMS
  const assetSelect = page.getByLabel('설비', { exact: true });
  const compressorValue = await assetSelect.locator('option').filter({ hasText: /^COMP1 · / }).getAttribute('value');
  await assetSelect.selectOption(compressorValue ?? '');
  await page.getByLabel('메트릭', { exact: true }).selectOption('vibration.rms');
  await page.getByLabel(/수집 주기/).fill('300');
  await page.getByRole('button', { name: '포인트 만들기' }).click();
  await expect(page.getByRole('heading', { name: '2. 재처리' })).toBeVisible();

  // 2. 재처리: 보존된 원본 배치에서 과거 값을 채운다
  await page.getByRole('button', { name: '재처리 실행' }).click();
  const done = page.getByRole('status').filter({ hasText: /재처리를 마쳤습니다\. 새로 적재된 행 [\d,]+개/ });
  await expect(done).toBeVisible({ timeout: 60_000 });
  const accepted = Number((/새로 적재된 행 ([\d,]+)개/.exec((await done.textContent()) ?? '')?.[1] ?? '0').replaceAll(',', ''));
  expect(accepted).toBeGreaterThan(0);

  // 3. 결과 링크 → 압축기 자산 상세의 포인트 목록
  await done.getByRole('link', { name: /COMP1 · 진동 속도 RMS 차트 보기/ }).click();
  await expect(page).toHaveURL(new RegExp(`/sites/${E2E_INGEST_SITE}/assets/\\d+\\?points=\\d+&range=30d$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('수소 압축기');

  const row = page.getByRole('region', { name: '포인트 목록 표' }).getByRole('row').filter({ hasText: 'vibration.rms' });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole('cell'); // [원본 태그, 최신값, 단위, 품질, 마지막 수신]
  await expect(cells.nth(0)).toHaveText(UNMAPPED_TAG);
  await expect(cells.nth(1)).toHaveText(/^-?\d[\d,]*(\.\d+)?$/);
  await expect(cells.nth(2)).toHaveText('mm/s');
  await expect(cells.nth(3)).toContainText('재처리'); // 매핑 전에 받은 값이므로 재처리 비트가 붙는다
});
