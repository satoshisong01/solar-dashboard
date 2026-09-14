import { expect, test, type Page } from '@playwright/test';
import { E2E_INGEST_SITE, SIGNED_OUT } from './e2e-env';

// chromium 프로젝트의 storageState(로그인 세션)를 쓴다. 테스트 DB는 globalSetup이 매번 초기화한다 (SIM-B 최근 2일 적재).
// 발견사항이 없어도 리포트는 KPI·데이터 품질·안전 고정 문구로 만들어지고 검증을 통과해야 한다.

const panel = (page: Page, title: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();

test('코칭 리포트: 사이트·월 선택 → 리포트 만들기 → 숫자 잠금 편집 → 승인 → 인쇄 화면(PDF 출력)', async ({ page }) => {
  await page.goto('/reports');
  const create = panel(page, '리포트 만들기');
  await expect(create).toContainText('분석 실행과 별개');
  await create.locator('select[name=site]').selectOption(E2E_INGEST_SITE);
  await expect(create.getByRole('radio', { name: '월간' })).toBeChecked();
  await create.getByRole('button', { name: '발견사항 불러오기' }).click();
  await expect(page).toHaveURL(/\/reports\?site=SIM-B&kind=month&month=\d{4}-\d{2}/);
  await expect(create).toContainText('분석을 실행하지 않고');

  await create.getByRole('button', { name: '리포트 만들기' }).click();
  await expect(page).toHaveURL(/\/reports\/\d+$/, { timeout: 60_000 });
  await expect(panel(page, '검증기 결과')).toContainText('검증 통과');
  const safety = page.locator('[id="block-safety.notice"]');
  await expect(safety).toContainText('이 리포트는 법정 안전설비·현장 PLC 인터록 판단을 대체하지 않습니다.');
  await expect(safety.getByRole('button', { name: '문장 편집' })).toHaveCount(0);

  const overview = page.locator('[id="block-summary.overview"]');
  await overview.getByRole('button', { name: '문장 편집' }).click();
  const textarea = overview.getByRole('textbox');
  await textarea.fill((await textarea.inputValue()).replace(/발견사항 \d+건/, '발견사항 99건'));
  await expect(overview.getByRole('alert')).toContainText('숫자는 편집할 수 없습니다');
  await expect(overview.getByRole('button', { name: '문장 저장' })).toBeDisabled();
  await overview.getByRole('button', { name: '취소' }).click();

  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page).toHaveURL(/\?approved=\d+/, { timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: '승인했습니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: '문장 편집' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 초안 만들기' })).toBeVisible();

  await page.getByRole('link', { name: '인쇄 화면 (PDF 출력)' }).click();
  await expect(page).toHaveURL(/\/reports\/\d+\/print$/);
  await expect(page.getByRole('button', { name: 'PDF 출력' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '사이트 유지보수 코칭 리포트' })).toBeVisible();
  await expect(page.getByText('이 리포트는 법정 안전설비·현장 PLC 인터록 판단을 대체하지 않습니다.')).toBeVisible();
});

test('조치 추적: CSV 행 오류 미리보기 → 정상 파일 가져오기 → 목록에 검증 상태 표시', async ({ page }) => {
  await page.goto('/actions');
  await expect(page.getByText('조치 효과 검증은 분석 데스크에서 분석을 실행할 때 함께 계산됩니다')).toBeVisible();
  for (const title of ['검증 대기 큐', '조치 목록', '조치 직접 등록', 'CSV 가져오기']) await expect(panel(page, title)).toBeVisible();

  const csv = panel(page, 'CSV 가져오기');
  const header = 'site_code,asset_path,action_type,performed_at,performed_by,notes';
  await csv.locator('input[type=file]').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\nSIM-B,SIM-B/NOPE,점검,2026-08-01,,\n`) });
  await expect(csv.getByRole('alert')).toContainText('2행: asset_path: SIM-B에 없는 설비입니다 (SIM-B/NOPE)', { timeout: 30_000 });
  await expect(csv.getByRole('button', { name: /행 가져오기/ })).toBeDisabled();

  await csv.locator('input[type=file]').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\nSIM-B,SIM-B/ESS1/RACK01,E2E 정기 점검,2026-08-01 09:00,E2E,\n`) });
  await csv.getByRole('button', { name: '1행 가져오기' }).click();
  await expect(csv.getByRole('status').filter({ hasText: '조치 1건을 가져왔습니다' })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole('region', { name: '조치 목록 표' }).locator('tbody tr', { hasText: 'E2E 정기 점검' });
  await expect(row).toContainText('검증 안 함 (기대 효과 없음)');
  await expect(row).toContainText('CSV');
});

test.describe('비로그인', () => {
  test.use({ storageState: SIGNED_OUT });

  test('리포트 인쇄 화면·조치 상세도 로그인으로 보낸다', async ({ page }) => {
    for (const href of ['/reports/1/print', '/reports/1', '/actions/1']) {
      await page.goto(href);
      await expect(page).toHaveURL('/login');
    }
  });
});
