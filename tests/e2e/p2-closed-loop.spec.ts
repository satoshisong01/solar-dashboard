import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';
import { LOOP_ASSETS, LOOP_INPUTS, LOOP_SITE } from './closed-loop-plan';
import { E2E_BASE_URL, SIGNED_OUT } from './e2e-env';

// 폐루프 E2E (설계 §8 P2 완료 기준): 분석 실행 → 발견사항 → 근거 확인 → 분류·조치 → 재분석 효과 검증 → 기각·기준선 재설정 → 리포트 승인·인쇄.
// 데이터: globalSetup이 SIM-A 과거 80일(closed-loop-plan.ts)을 적재했다. 테스트는 앞 단계가 만든 상태를 이어 쓴다 (serial).

test.describe.configure({ mode: 'serial' });

const RUN_TIMEOUT_MS = 180_000;
const panel = (page: Page, title: string): Locator => page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
const findingIds = { capacity: '', cellImbalance: '', inverter: '' };

async function runLoopAnalysis(page: Page, period: Readonly<{ from: string; to: string }>): Promise<Locator> {
  await page.goto('/desk');
  const run = panel(page, '분석 실행');
  for (const code of ['SIM-B', 'SIM-C']) await run.getByRole('checkbox', { name: new RegExp(code) }).uncheck();
  await expect(run.getByRole('checkbox', { name: new RegExp(LOOP_SITE) })).toBeChecked();
  await run.getByRole('radio', { name: '사용자 지정' }).check();
  await run.getByLabel('시작 (KST)').fill(period.from);
  await run.getByLabel(/^끝 \(KST/).fill(period.to);
  await run.getByRole('button', { name: '분석 실행' }).click();
  await expect(run.getByRole('status').filter({ hasText: '마쳤습니다' })).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  return run;
}

/** 실행 결과 요약의 한 항목 값 (예: '새 발견사항' → '3건') */
const summaryValue = (run: Locator, label: string): Locator => run.locator('dl > div', { has: run.page().getByText(label, { exact: true }) }).locator('dd');

async function inboxRow(page: Page, assetCode: string, detector: string): Promise<Locator> {
  await page.goto(`/desk?site=${LOOP_SITE}&status=all`);
  return page.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr', { hasText: `${assetCode} · ${detector}` });
}

async function findingIdOf(page: Page, assetCode: string, detector: string): Promise<string> {
  const row = await inboxRow(page, assetCode, detector);
  await expect(row).toHaveCount(1);
  const href = await row.getByRole('link').first().getAttribute('href');
  const id = /^\/desk\/(\d+)$/.exec(href ?? '')?.[1];
  if (!id) throw new Error(`${assetCode} ${detector} 발견사항 링크를 찾지 못했습니다: ${href}`);
  return id;
}

async function reportCount(page: Page): Promise<number> {
  await page.goto('/reports');
  await expect(panel(page, '리포트 목록')).toBeVisible();
  return page.getByRole('region', { name: '리포트 목록 표' }).locator('tbody tr').count();
}

/** 리포트 용량 감소 문장 (표시 반올림으로 끝자리 0은 빠진다: −7%) */
const CAPACITY_SENTENCE = /유효용량이 [\d.]+ Ah → [\d.]+ Ah로 −[\d.]+%/;
const statusBadge = (page: Page, label: string): Locator => page.locator('header').getByText(label, { exact: true });

test('(1) SIM-A 1차 기간 분석 실행 → 용량 감소·셀 불균형·인버터 발견사항 3건 생성', async ({ page }) => {
  test.slow();
  const run = await runLoopAnalysis(page, LOOP_INPUTS.firstRun);
  await expect(summaryValue(run, '새 발견사항')).toHaveText('3건');
  await expect(page.getByRole('region', { name: '최근 분석 실행 표' }).locator('tbody tr').first()).toContainText(LOOP_SITE);

  findingIds.capacity = await findingIdOf(page, LOOP_ASSETS.capacity, '배터리 유효용량 감소');
  findingIds.cellImbalance = await findingIdOf(page, LOOP_ASSETS.cellImbalance, '셀 전압 편차 증가');
  findingIds.inverter = await findingIdOf(page, LOOP_ASSETS.inverter, '인버터 동종 비교');
  const capacityRow = await inboxRow(page, LOOP_ASSETS.capacity, '배터리 유효용량 감소');
  await expect(capacityRow).toContainText(/배터리 유효용량 \d+\.\d% 감소/);
  await expect(capacityRow).toContainText('95% CI');
  await expect(capacityRow).toContainText('새 발견');
});

test('(2) 워크스페이스: 용량 감소 효과·95% CI·같은 조건 비교표·에피소드 오버레이 차트·원인 후보 판별 체크', async ({ page }) => {
  await page.goto(`/desk/${findingIds.capacity}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/배터리 유효용량 \d+\.\d% 감소/);
  await expect(page.getByLabel('탐지기 신뢰 배지')).toBeVisible();

  const effect = panel(page, '효과');
  await expect(effect).toContainText(/−\d+\.\d{2}%/);
  await expect(effect).toContainText(/95% CI −\d+\.\d{2} ~ −\d+\.\d{2}/);
  await expect(effect).toContainText(/\d+\.\d{2} Ah → \d+\.\d{2} Ah/);
  await expect(effect).toContainText('같은 조건');

  const bins = page.getByRole('region', { name: '같은 조건 비교표' }).locator('tbody tr');
  await expect(bins.filter({ hasText: '사용' }).first()).toBeVisible();

  const overlay = panel(page, '에피소드 오버레이');
  await expect(overlay.getByRole('img', { name: /^에피소드 오버레이 차트: x축 경과/ }).locator('canvas').first()).toBeVisible();
  await overlay.getByRole('button', { name: 'SOC', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'SOC', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(overlay.getByRole('img', { name: /^에피소드 오버레이 차트: x축 SOC/ }).locator('canvas').first()).toBeVisible();
  await expect(overlay).toContainText('기준 대표 충전');
  await expect(overlay).toContainText('최근 대표 충전');

  const checks = page.getByRole('region', { name: '원인 후보 판별 체크 표' }).locator('tbody tr');
  expect(await checks.count()).toBeGreaterThan(0);
  await expect(checks.first()).toContainText(/지지|반박|불명|데이터 없음/);
});

test('(3) 셀 불균형 발견사항 분류(조사 중) → 권고 조치 작성(밸런싱 시각·셀 편차 감소) → 조치 완료', async ({ page }) => {
  await page.goto(`/desk/${findingIds.cellImbalance}`);
  await expect(statusBadge(page, '새 발견')).toBeVisible();
  await page.getByRole('button', { name: '분류 (조사 중)' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1건을 분류(조사 중)로 옮겼습니다' })).toBeVisible();
  await expect(statusBadge(page, '분류됨')).toBeVisible();

  const form = panel(page, '권고 조치 작성');
  await form.getByLabel('조치 종류').fill('셀 밸런싱 (완충 유지)');
  await form.getByLabel(/^수행일시/).fill(LOOP_INPUTS.balancingAt);
  await expect(form.getByLabel('검증 지표')).toHaveValue('ess.cell_dv_mv');
  await expect(form.getByLabel('기대 방향')).toHaveValue('decrease');
  await form.getByLabel(/^최소 변화량/).fill('10');
  await expect(form.getByLabel('안정화 일수')).toHaveValue('3');
  await form.getByRole('button', { name: '조치 기록' }).click();
  await expect(form.getByRole('status').filter({ hasText: '조치를 기록했습니다' })).toBeVisible();

  await expect(statusBadge(page, '조치 완료')).toBeVisible();
  await expect(panel(page, '활동 타임라인')).toContainText('조치 기록: 셀 밸런싱 (완충 유지)');
});

test('(4) 조치 뒤 안정화·비교 창이 지난 기간까지 재분석 → 효과 검증 개선 확인 → 효과 확인(verified)', async ({ page }) => {
  test.slow();
  const run = await runLoopAnalysis(page, LOOP_INPUTS.secondRun);
  await expect(summaryValue(run, '새 발견사항')).toHaveText('0건');

  await page.goto(`/desk/${findingIds.cellImbalance}`);
  await expect(statusBadge(page, '효과 확인')).toBeVisible();
  const timeline = panel(page, '활동 타임라인');
  await expect(timeline).toContainText('조치 효과 검증: 개선 확인');
  await expect(timeline).toContainText('상태 조치 완료 → 효과 확인');
  await expect(timeline).toContainText(/효과 −\d+\.\d+ mV \(95% CI −\d+\.\d+ ~ −\d+\.\d+\)/);

  await page.goto('/actions');
  const row = page.getByRole('region', { name: '조치 목록 표' }).locator('tbody tr', { hasText: '셀 밸런싱 (완충 유지)' });
  await expect(row).toContainText('개선 확인');
  await expect(row).toContainText(`#${findingIds.cellImbalance}`);
  await expect(row).toContainText('효과 확인');
});

test("(5) 인버터 발견사항 기각('운영 조건 변경' + 기준선 재설정) → 같은 기간 재분석에서 같은 발견사항이 다시 생기지 않는다", async ({ page }) => {
  test.slow();
  await page.goto(`/desk/${findingIds.inverter}`);
  await page.getByRole('button', { name: '기각…' }).click();
  await page.getByLabel(/^기각 사유/).selectOption('운영 조건 변경');
  await page.getByLabel('억제 기간 (일)').fill('0');
  await page.getByRole('checkbox', { name: /기준선 재설정 이벤트 만들기/ }).check();
  await page.getByLabel('운영 조건이 바뀐 시점 (KST)').fill(LOOP_INPUTS.inverterBaselineAt);
  await page.getByRole('button', { name: '기각', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '1건을 기각했습니다. 기준선 분할 이벤트 1건을 만들었습니다.' })).toBeVisible();
  await expect(statusBadge(page, '기각')).toBeVisible();

  // 억제 기간 0일이므로 기준선 재설정이 없으면 재발 발견사항(새 발견사항 1건)이 생긴다
  const run = await runLoopAnalysis(page, LOOP_INPUTS.secondRun);
  await expect(summaryValue(run, '새 발견사항')).toHaveText('0건');
  await expect(summaryValue(run, '갱신')).toHaveText('1건');

  const rows = page.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr');
  await inboxRow(page, LOOP_ASSETS.inverter, '인버터 동종 비교');
  await expect(rows).toHaveCount(3);
  const inverter = rows.filter({ hasText: `${LOOP_ASSETS.inverter} · 인버터 동종 비교` });
  await expect(inverter).toHaveCount(1);
  await expect(inverter).toContainText('기각');
  await expect(inverter).not.toContainText('재발');
});

test('(6) 리포트 만들기(SIM-A) → 검증 통과 → 숫자 편집 거부·문장 편집 저장 → 승인 → 용량 발견사항 리포트 반영 → 인쇄 화면', async ({ page }) => {
  await page.goto(`/reports?site=${LOOP_SITE}&kind=month&month=${LOOP_INPUTS.reportMonth}`);
  const create = panel(page, '리포트 만들기');
  await expect(create.getByRole('checkbox', { name: `발견사항 #${findingIds.capacity} 포함` })).toBeChecked();
  await create.getByRole('button', { name: '리포트 만들기' }).click();
  await expect(page).toHaveURL(/\/reports\/\d+$/, { timeout: 60_000 });
  const reportId = /\/reports\/(\d+)$/.exec(page.url())?.[1] ?? '';
  await expect(panel(page, '검증기 결과')).toContainText('검증 통과');

  const block = page.locator(`[id="block-finding.${findingIds.capacity}.message"]`);
  await expect(block).toContainText(CAPACITY_SENTENCE);
  await block.getByRole('button', { name: '문장 편집' }).click();
  const textarea = block.getByRole('textbox');
  const original = await textarea.inputValue();
  await textarea.fill(original.replace(/유효용량이 [\d.]+ Ah/, '유효용량이 999.9 Ah'));
  await expect(block.getByRole('alert')).toContainText('숫자는 편집할 수 없습니다');
  await expect(block.getByRole('button', { name: '문장 저장' })).toBeDisabled();
  await textarea.fill(original.replace('감소했습니다.', '줄었습니다.'));
  await block.getByRole('button', { name: '문장 저장' }).click();
  await expect(block).toContainText('줄었습니다.');
  await expect(panel(page, '검증기 결과')).toContainText('검증 통과');

  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page).toHaveURL(/\?approved=\d+/, { timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: '승인했습니다' })).toBeVisible();

  await page.goto(`/desk/${findingIds.capacity}`);
  await expect(statusBadge(page, '리포트 반영')).toBeVisible();
  await expect(panel(page, '활동 타임라인')).toContainText(`리포트 #${reportId} 승인`);

  await page.goto(`/reports/${reportId}/print`);
  await expect(page.getByRole('button', { name: 'PDF 출력' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '사이트 유지보수 코칭 리포트' })).toBeVisible();
  await expect(page.getByText(/유효용량이 [\d.]+ Ah → [\d.]+ Ah로 −[\d.]+%.*줄었습니다\./).first()).toBeVisible();
});

test('(7) 분석을 다시 실행해도 리포트는 만들어지지 않는다 (리포트 수·승인 상태 그대로)', async ({ page }) => {
  test.slow();
  const before = await reportCount(page);
  expect(before).toBeGreaterThan(0);
  const run = await runLoopAnalysis(page, LOOP_INPUTS.secondRun);
  await expect(run).toContainText('리포트나 파일을 만들지 않습니다');
  expect(await reportCount(page)).toBe(before);
  await expect(page.getByRole('region', { name: '리포트 목록 표' }).locator('tbody tr', { hasText: LOOP_SITE }).first()).toContainText('승인');
});

test('(8) 조치 CSV 가져오기: 오류 행마다 행 번호와 사유를 안내하고 아무것도 가져오지 않는다', async ({ page }) => {
  await page.goto('/actions');
  const list = page.getByRole('region', { name: '조치 목록 표' }).locator('tbody tr');
  const before = await list.count();
  const csv = panel(page, 'CSV 가져오기');
  const lines = [
    'site_code,asset_path,action_type,performed_at,performed_by,notes,finding_id',
    `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK02,E2E 외관 점검,2026-07-01 09:00,E2E,,`,
    `SIM-X,SIM-X/ESS1/RACK01,점검,2026-07-01 09:00,,,`,
    `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK09,점검,2026-07-01 09:00,,,`,
    `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK02,점검,2026/07/01,,,`,
    `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK01,용량 시험,2026-07-01 09:00,,,${findingIds.cellImbalance}`,
    `${LOOP_SITE},${LOOP_SITE}/PV1/INV01,팬 청소,2026-07-01 09:00,,,${findingIds.inverter}`,
    `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK02,E2E 외관 점검,2026-07-01 09:00,E2E,,`,
  ];
  await csv.locator('input[type=file]').setInputFiles({ name: 'loop-actions.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
  const alert = csv.getByRole('alert');
  await expect(alert).toContainText('오류가 한 행이라도 있으면 아무것도 가져오지 않습니다', { timeout: 30_000 });
  for (const message of [
    '3행: site_code: 없는 사이트입니다 (SIM-X)',
    `4행: asset_path: ${LOOP_SITE}에 없는 설비입니다 (${LOOP_SITE}/ESS1/RACK09)`,
    '5행: performed_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST)이어야 합니다',
    `6행: finding_id: 발견사항 ${findingIds.cellImbalance}은(는) 다른 설비의 발견사항입니다`,
    `7행: finding_id: 발견사항 ${findingIds.inverter}은(는) 닫혀 있습니다. 먼저 다시 여세요`,
    '8행: 2행과 설비·조치 종류·수행일시가 겹칩니다',
  ]) {
    await expect(alert).toContainText(message);
  }
  await expect(csv).toContainText('오류 6건');
  await expect(csv.getByRole('button', { name: /행 가져오기/ })).toBeDisabled();
  await page.reload();
  await expect(list).toHaveCount(before);
});

interface CapturedAction {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** 로그인한 화면에서 Server Action 요청을 서버에 보내지 않고 가로챈다 (헤더·본문을 비로그인 재전송에 쓴다) */
async function captureServerAction(page: Page, path: string, trigger: () => Promise<void>): Promise<CapturedAction> {
  let captured: Request | null = null;
  const matches = (url: URL): boolean => url.pathname === path;
  await page.route(matches, async (route) => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    captured = route.request();
    await route.abort();
  });
  await trigger();
  await expect.poll(() => captured !== null).toBe(true);
  await page.unroute(matches);
  const request = captured as Request | null;
  if (!request) throw new Error(`${path} Server Action 요청을 가로채지 못했습니다`);
  const url = new URL(request.url());
  const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => name !== 'cookie'));
  return { path: `${url.pathname}${url.search}`, headers, body: request.postDataBuffer() ?? Buffer.alloc(0) };
}

/**
 * 쿠키 없음: proxy가 307로 로그인에 보낸다.
 * 위조 쿠키: proxy는 지나가지만 Server Action 첫 줄 requireAdmin()이 redirect — Next Server Action 규약대로 x-action-redirect: /login.
 * 어느 쪽이든 부작용이 없어야 하므로 호출한 쪽에서 실행 이력·리포트 수를 다시 확인한다.
 */
async function expectBlocked(request: APIRequestContext, action: CapturedAction, cookie?: string): Promise<void> {
  const response = await request.post(action.path, { headers: { ...action.headers, ...(cookie ? { cookie } : {}) }, data: action.body, maxRedirects: 0 });
  const headers = response.headers();
  const detail = `${action.path}${cookie ? ' (위조 쿠키)' : ''} 응답 ${response.status()} location=${headers['location'] ?? ''} x-action-redirect=${headers['x-action-redirect'] ?? ''}`;
  if (cookie) {
    expect(headers['x-action-redirect'], detail).toMatch(/^\/login(;|$)/);
  } else {
    expect(response.status(), detail).toBe(307);
    expect(headers['location'], detail).toMatch(/\/login$/);
  }
}

test('(9) 비로그인: /desk·/reports·/actions 화면은 로그인으로 보내고, 가로챈 실제 Server Action 재전송도 아무것도 바꾸지 못한다', async ({ page, playwright }) => {
  // 가로챈 요청은 중단되므로 화면이 오류 상태가 된다. 비교 기준은 가로채기 전에 읽는다.
  await page.goto('/desk');
  const latestRun = page.getByRole('region', { name: '최근 분석 실행 표' }).locator('tbody tr').first();
  const runsBefore = (await latestRun.textContent()) ?? '';
  const runAction = await captureServerAction(page, '/desk', () => panel(page, '분석 실행').getByRole('button', { name: '분석 실행' }).click());
  const reportsBefore = await reportCount(page);
  await page.goto(`/reports?site=${LOOP_SITE}&kind=month&month=${LOOP_INPUTS.reportMonth}`);
  const reportAction = await captureServerAction(page, '/reports', () => panel(page, '리포트 만들기').getByRole('button', { name: '리포트 만들기' }).click());
  await page.goto('/actions');
  const actionRows = page.getByRole('region', { name: '조치 목록 표' }).locator('tbody tr');
  const actionsBefore = await actionRows.count();
  const csv = panel(page, 'CSV 가져오기');
  const csvText = ['site_code,asset_path,action_type,performed_at,performed_by,notes', `${LOOP_SITE},${LOOP_SITE}/ESS1/RACK02,E2E 재전송 확인,2026-07-02 09:00,E2E,`].join('\n');
  await csv.locator('input[type=file]').setInputFiles({ name: 'replay.csv', mimeType: 'text/csv', buffer: Buffer.from(csvText) });
  const importButton = csv.getByRole('button', { name: '1행 가져오기' });
  await expect(importButton).toBeEnabled({ timeout: 30_000 });
  const importAction = await captureServerAction(page, '/actions', () => importButton.click());

  const anonymous = await playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: SIGNED_OUT });
  try {
    for (const href of ['/desk', `/desk/${findingIds.capacity}`, '/reports', '/actions']) {
      const response = await anonymous.get(href, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers()['location']).toMatch(/\/login$/);
    }
    for (const action of [runAction, reportAction, importAction]) {
      await expectBlocked(anonymous, action);
      await expectBlocked(anonymous, action, 'better-auth.session_token=forged-token.forged-signature');
    }
  } finally {
    await anonymous.dispose();
  }

  expect(await reportCount(page)).toBe(reportsBefore);
  await page.goto('/actions');
  await expect(actionRows).toHaveCount(actionsBefore);
  await page.goto('/desk');
  await expect(latestRun).toHaveText(runsBefore);
});

test('(10) HYSOL_SHOW_SIM 없이는 /sim 이 404 (찾을 수 없음)', async ({ page }) => {
  const response = await page.goto('/sim');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible();
});
