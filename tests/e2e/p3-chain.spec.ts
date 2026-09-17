import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL, SIGNED_OUT } from './e2e-env';
import { P3_ASSETS, P3_DAYS, P3_INPUTS, P3_SITE } from './p3-chain-plan';
import { captureServerAction, expectBlocked, FORGED_SESSION_COOKIE } from './server-action';

// P3 수소 체인 E2E (설계 §8 P3): 분석 실행 → 누설 안전 발견사항·물질수지 사이트 발견사항 → 오늘 배너 → 누설 근거 → 체인 원장 섹션
// → 탐지 준비도 → 탐지기 설정 버전 → 리포트(안전 블록·방향 단어 검증) → 조치 효과 검증 → 비로그인 차단 → 분석은 리포트를 만들지 않음.
// 데이터: globalSetup이 SIM-B 과거 21일(p3-chain-plan.ts)을 적재했다. 테스트는 앞 단계가 만든 상태를 이어 쓴다 (serial).

test.describe.configure({ mode: 'serial' });

const RUN_TIMEOUT_MS = 180_000;
const SAFETY_NOTICE = '이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.';
const MASS_BALANCE_DETECTOR = 'h2chain.mass_balance_gap';
const panel = (page: Page, title: string): Locator => page.locator('section', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
const summaryValue = (run: Locator, label: string): Locator => run.locator('dl > div', { has: run.page().getByText(label, { exact: true }) }).locator('dd');
const chartCanvas = (scope: Locator, name: string | RegExp): Locator => scope.getByRole('img', { name }).locator('canvas').first();
const ids = { leak: '', massBalance: '', report: '' };

async function runChainAnalysis(page: Page): Promise<Locator> {
  await page.goto('/desk');
  const run = panel(page, '분석 실행');
  for (const code of ['SIM-A', 'SIM-C', 'GP-1']) await run.getByRole('checkbox', { name: new RegExp(code) }).uncheck();
  await expect(run.getByRole('checkbox', { name: new RegExp(P3_SITE) })).toBeChecked();
  await run.getByRole('radio', { name: '사용자 지정' }).check();
  await run.getByLabel('시작 (KST)').fill(P3_INPUTS.run.from);
  await run.getByLabel(/^끝 \(KST/).fill(P3_INPUTS.run.to);
  await run.getByRole('button', { name: '분석 실행' }).click();
  // 실행 버튼은 바로 응답하고 계산은 서버가 응답 뒤에 잇는다: 끝나면 진행 표시가 결과 요약으로 바뀐다
  await expect(run.getByRole('status').filter({ hasText: /완료|일부 완료/ })).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  return run;
}

async function findingIdOf(page: Page, rowText: string): Promise<string> {
  await page.goto(`/desk?site=${P3_SITE}&status=all`);
  const row = page.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr', { hasText: rowText });
  await expect(row).toHaveCount(1);
  const href = await row.getByRole('link').first().getAttribute('href');
  const id = /^\/desk\/(\d+)$/.exec(href ?? '')?.[1];
  if (!id) throw new Error(`${rowText} 발견사항 링크를 찾지 못했습니다: ${href}`);
  return id;
}

async function reportCount(page: Page): Promise<number> {
  await page.goto('/reports');
  await expect(panel(page, '리포트 목록')).toBeVisible();
  return page.getByRole('region', { name: '리포트 목록 표' }).locator('tbody tr').count();
}

const configPath = `/settings/detectors/${MASS_BALANCE_DETECTOR}`;
const versionRows = (page: Page): Locator => page.getByRole('region', { name: 'default 버전 이력 표' }).locator('tbody tr');
const versionRow = (page: Page, version: number): Locator => versionRows(page).filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${version}$`) }) });

async function saveResidualPct(page: Page, value: string): Promise<void> {
  const form = panel(page, '새 버전 만들기');
  await form.locator('#param-residualPct').fill(value);
  await form.getByRole('button', { name: '새 버전 저장' }).click();
}

test('(1) SIM-B 수소 체인 기간 분석 실행 → 누설 안전 발견사항(심각도 4)·물질수지 사이트 발견사항 → 오늘 화면 안전 발견사항 배너', async ({ page }) => {
  test.slow();
  const run = await runChainAnalysis(page);
  await expect(run).toContainText('리포트나 파일을 만들지 않습니다');
  expect(Number(/^(\d+)건/.exec((await summaryValue(run, '새 발견사항').textContent()) ?? '')?.[1])).toBeGreaterThanOrEqual(2);

  ids.leak = await findingIdOf(page, `${P3_ASSETS.leakTank} · 저장용기 정지 보유 누설`);
  const leakRow = page.getByRole('region', { name: '발견사항 인박스 표' }).locator('tbody tr', { hasText: `${P3_ASSETS.leakTank} · 저장용기 정지 보유 누설` });
  await expect(leakRow).toContainText('안전');
  await expect(leakRow).toContainText('심각도 4 ·');
  await expect(leakRow).toContainText(/저장용기 누설 의심 [\d.]+ kg\/일/);
  ids.massBalance = await findingIdOf(page, '사이트 단위 · 수소 물질수지 잔차');

  await page.goto('/');
  const banner = page.getByRole('region', { name: /^열린 안전 발견사항 \d+건/ });
  await expect(banner).toBeVisible();
  const item = banner.getByRole('listitem').filter({ has: page.locator(`a[href="/desk/${ids.leak}"]`) });
  await expect(item).toContainText(P3_SITE);
  await expect(item).toContainText(P3_ASSETS.leakTank);
  await expect(item).toContainText('심각도 4 ·');
  await expect(banner).toContainText(SAFETY_NOTICE);
});

test('(2) 누설 워크스페이스: 안전 배너·대체 불가 문구, 정지 보유 구간 표(최근·기준)·대표 구간 곡선·누설률 추세 캔버스', async ({ page }) => {
  await page.goto(`/desk/${ids.leak}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/저장용기 누설 의심/);
  const safety = page.getByRole('region', { name: /^안전 발견사항 — 현장 안전책임자 판단/ });
  await expect(safety).toBeVisible();
  await expect(safety).toContainText(SAFETY_NOTICE);
  await expect(page.getByRole('region', { name: '쉬운 요약' })).toContainText('수소를 넣지도 빼지도 않는 동안');
  await page.locator('summary', { hasText: '자세히 보기' }).click();

  const holdsPanel = panel(page, '정지 보유 구간');
  await expect(holdsPanel).toContainText(/결합 누설률[\d.]+ kg\/일 \(95% CI [\d.]+ ~ [\d.]+\)/);
  await expect(holdsPanel).toContainText('해당 (severity 4)');
  const holds = page.getByRole('region', { name: '정지 보유 구간 표' }).locator('tbody tr');
  expect(await holds.filter({ has: page.locator('td:first-child', { hasText: /^최근$/ }) }).count()).toBeGreaterThanOrEqual(4);
  expect(await holds.filter({ has: page.locator('td:first-child', { hasText: /^기준$/ }) }).count()).toBeGreaterThanOrEqual(6);
  await expect(chartCanvas(panel(page, '대표 정지 구간 곡선'), '대표 정지 보유 구간 압력·온도·온도 보정 질량 곡선')).toBeVisible();
  await expect(chartCanvas(panel(page, '누설률 추세'), /^정지 보유 구간별 손실률 추세/)).toBeVisible();
});

test('(3) 사이트 체인 원장 섹션: 기간 지정(URL 유지) → 에너지·수소 Sankey·물질수지 잔차 막대·PV 미활용 분해 막대·열린 물질수지 발견사항', async ({ page }) => {
  await page.goto(`/sites/${P3_SITE}`);
  const form = page.getByRole('form', { name: '체인 원장 기간 선택' });
  await form.getByRole('radio', { name: '사용자 지정' }).check();
  await form.getByLabel('시작일').fill(P3_INPUTS.chain.from);
  await form.getByLabel('끝일').fill(P3_INPUTS.chain.to);
  await form.getByRole('button', { name: '적용' }).click();
  await expect(page).toHaveURL(new RegExp(`/sites/${P3_SITE}\\?chain=custom&from=${P3_INPUTS.chain.from}&to=${P3_INPUTS.chain.to}`));

  const chain = page.locator('section#chain');
  await expect(chain).toContainText(`저장된 날 ${P3_DAYS}일`);
  await expect(chartCanvas(panel(page, '에너지 흐름 [kWh]'), /^에너지 흐름 Sankey/)).toBeVisible();
  await expect(chartCanvas(panel(page, '수소 흐름 [kg]'), /^수소 흐름 Sankey/)).toBeVisible();
  const residual = panel(page, '수소 물질수지 잔차');
  await expect(chartCanvas(residual, /^수소 물질수지 잔차 일별 막대/)).toBeVisible();
  await expect(residual.getByRole('list', { name: '열린 물질수지 발견사항' }).locator(`a[href="/desk/${ids.massBalance}"]`)).toBeVisible();
  const pvLoss = panel(page, 'PV 미활용 원인 분해 [kWh]');
  await expect(chartCanvas(pvLoss, /^PV 미활용 원인 분해 일별 누적 막대/)).toBeVisible();
  await expect(pvLoss.getByRole('region', { name: 'PV 미활용 원인 기간 합 표' })).toBeVisible();
  await expect(panel(page, '체인 KPI')).toContainText(/물질수지 잔차율\+?\d+\.\d{2} %/);
});

test('(4) 탐지 준비도: SIM-B 매트릭스·메트릭 확보 순위 → CSV 내려받기(파일명·BOM·헤더·첫 행)', async ({ page }) => {
  await page.goto(`/data/readiness?site=${P3_SITE}`);
  const matrix = page.getByRole('region', { name: '탐지 준비도 매트릭스 (설비 × 탐지기)' });
  await expect(matrix.locator('tbody tr').first().getByRole('rowheader')).toContainText('(사이트 전체)');
  expect(await matrix.locator('tbody tr').count()).toBeGreaterThan(10);
  const ranking = panel(page, '메트릭 확보 순위');
  await expect(ranking.getByRole('region', { name: '메트릭 확보 순위 표' }).or(ranking.getByText('누락된 필수 메트릭이 없습니다'))).toBeVisible();

  const summary = panel(page, `${P3_SITE} 요약`);
  const [download] = await Promise.all([page.waitForEvent('download'), summary.getByRole('link', { name: 'CSV 내려받기' }).click()]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^탐지준비도_${P3_SITE}_\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const text = await readFile(await download.path(), 'utf8');
  expect(text.startsWith('﻿')).toBe(true);
  const [header, first] = text.slice(1).split('\r\n');
  expect(header).toBe('설비 경로 (asset_code),설비 종류 (asset_class),탐지기 (detector_id),고장모드 (failure_mode),심각도 (severity),상태 (status),상태 설명 (status_label),누락 필수 메트릭 (missing_metrics),누락 권장 메트릭 (recommended_missing),부족 사유 (reasons)');
  expect(first).toMatch(/^\(사이트 전체\),site,[a-z0-9_.]+,[a-z0-9_.]+,\d,(ready|partial|missing|n\/a),(준비됨|부분 준비|필수 메트릭 없음|해당 없음),/);

  const [acquisition] = await Promise.all([page.waitForEvent('download'), summary.getByRole('link', { name: '확보 순위 CSV' }).click()]);
  expect(acquisition.suggestedFilename()).toMatch(new RegExp(`^메트릭확보순위_${P3_SITE}_`));
  expect((await readFile(await acquisition.path(), 'utf8')).slice(1).split('\r\n')[0]).toBe('순위 (rank),메트릭 (metric_key),확보 시 풀리는 셀 (unlocks),심각도 가중 (severity_weight),관련 누락 셀 (blocked_cells)');
});

test('(5) 탐지기 설정: 운영 버전 v1 → 새 버전 v2 저장 → 범위 밖 값 거부 → 재분석 근거에 default@2 → v1 다시 활성', async ({ page }) => {
  test.slow();
  await page.goto(configPath);
  await expect(page.getByText('저장된 설정이 없습니다. 분석은 코드 기본값으로 실행됩니다.')).toBeVisible();
  await saveResidualPct(page, '2');
  await expect(panel(page, '새 버전 만들기').getByRole('status')).toContainText('default 버전 1을 저장하고 활성으로 바꿨습니다.');
  await saveResidualPct(page, '3');
  await expect(panel(page, '새 버전 만들기').getByRole('status')).toContainText('default 버전 2을 저장하고 활성으로 바꿨습니다.');
  await expect(versionRows(page)).toHaveCount(2);
  await expect(versionRow(page, 2)).toContainText('변경 잔차율 기준 (residualPct) 2 → 3');

  await saveResidualPct(page, '60');
  const form = panel(page, '새 버전 만들기');
  await expect(form.getByRole('alert')).toContainText('입력값을 확인하세요.');
  await expect(form).toContainText('0.1~50 % 사이여야 합니다');
  await page.reload();
  await expect(versionRows(page)).toHaveCount(2);
  await expect(versionRow(page, 2).locator('td').nth(1)).toHaveText('활성');

  await runChainAnalysis(page);
  await page.goto(`/desk/${ids.massBalance}`);
  await page.locator('summary', { hasText: '자세히 보기' }).click();
  await expect(panel(page, '효과')).toContainText('적용한 탐지기 설정: default@2');
  await page.goto(`/sites/${P3_SITE}?chain=custom&from=${P3_INPUTS.chain.from}&to=${P3_INPUTS.chain.to}`);
  await expect(panel(page, '수소 물질수지 잔차')).toContainText('기준 ±3% (설정 default@2)');

  await page.goto(configPath);
  await versionRow(page, 1).getByRole('button', { name: '활성으로' }).click();
  await expect(versionRow(page, 1).getByRole('status')).toContainText('default 버전 1을 활성으로 바꿨습니다.');
  await page.reload();
  await expect(page.getByRole('heading', { level: 3, name: /활성 버전 1/ })).toBeVisible();
  await expect(versionRow(page, 1).locator('td').nth(1)).toHaveText('활성');
  await expect(versionRow(page, 2).locator('td').nth(1)).toHaveText('비활성');
});

test("(6) 리포트 만들기(SIM-B): 심각도 4 인용·검증 통과 → 안전 블록이 요약 맨 앞 → 방향 단어 '증가'→'감소' 편집은 검증 문제 → 되돌려 승인 → 인쇄 화면 원장 절", async ({ page }) => {
  await page.goto(`/reports?site=${P3_SITE}&kind=month&month=${P3_INPUTS.reportMonth}`);
  const create = panel(page, '리포트 만들기');
  await expect(create.getByRole('checkbox', { name: `발견사항 #${ids.leak} 포함` })).toBeChecked();
  await expect(create.getByRole('checkbox', { name: `발견사항 #${ids.massBalance} 포함` })).toBeChecked();
  await create.getByRole('button', { name: '리포트 만들기' }).click();
  await expect(page).toHaveURL(/\/reports\/\d+$/, { timeout: 60_000 });
  ids.report = /\/reports\/(\d+)$/.exec(page.url())?.[1] ?? '';
  const validation = panel(page, '검증기 결과');
  await expect(validation).toContainText('검증 통과');

  const firstSummaryBlock = panel(page, '요약').locator('[id^="block-"]').first();
  await expect(firstSummaryBlock).toHaveAttribute('id', 'block-summary.urgent');
  await expect(firstSummaryBlock).toContainText(`즉시 확인 필요: [${P3_SITE}/${P3_ASSETS.leakTank}]`);
  await expect(firstSummaryBlock).toContainText('(심각도 4 · 바로 확인)');
  await expect(firstSummaryBlock).toContainText(SAFETY_NOTICE);
  await expect(firstSummaryBlock.getByRole('button', { name: '문장 편집' })).toHaveCount(0);

  const block = page.locator(`[id="block-finding.${ids.massBalance}.message"]`);
  await expect(block).toContainText('대비 증가했');
  const editDirection = async (from: string, to: string): Promise<void> => {
    await block.getByRole('button', { name: '문장 편집' }).click();
    const textarea = block.getByRole('textbox');
    await textarea.fill((await textarea.inputValue()).replace(from, to));
    await block.getByRole('button', { name: '문장 저장' }).click();
    await expect(block).toContainText(to);
  };
  await editDirection('대비 증가했', '대비 감소했');
  await expect(block).toContainText(`발견사항 #${ids.massBalance} 효과는 증가 방향인데 본문에 "감소" 표현이 있습니다`);
  await expect(validation).toContainText('문제 1건');
  await expect(page.getByRole('button', { name: '승인', exact: true })).toBeDisabled();

  await editDirection('대비 감소했', '대비 증가했');
  await expect(validation).toContainText('검증 통과');
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page).toHaveURL(/\?approved=\d+/, { timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: '승인했습니다' })).toBeVisible();

  await page.goto(`/reports/${ids.report}/print`);
  await expect(page.getByRole('button', { name: 'PDF 출력' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /^\d+\. 에너지·수소 원장$/ })).toBeVisible();
  await expect(page.getByRole('table', { name: /에너지·수소 원장 기간 합/ })).toContainText('수소 원장 (생산 − 소비 − 저장 증감 − 배기 = 잔차)');
  await expect(page.getByRole('img', { name: /^수소 원장 기간 합 막대/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PV 미활용 원인 기간 합 막대' })).toBeVisible();
  await expect(page.getByText(`즉시 확인 필요: [${P3_SITE}/${P3_ASSETS.leakTank}]`).first()).toBeVisible();
});

test('(7) 조치 직접 등록(압축기 밸브 교체·압축기 비에너지 감소 기대) → 검증만 실행: 픽스처 후 창으로 개선 확인', async ({ page }) => {
  await page.goto('/actions');
  const form = panel(page, '조치 직접 등록');
  const siteSelect = form.getByLabel('사이트');
  await siteSelect.selectOption((await siteSelect.locator('option', { hasText: `${P3_SITE} · ` }).getAttribute('value')) ?? '');
  const assetSelect = form.getByLabel('설비', { exact: true });
  const compressor = await assetSelect.locator('option', { hasText: `${P3_SITE}/${P3_ASSETS.compressor} · ` }).getAttribute('value');
  await assetSelect.selectOption(compressor ?? '');
  await form.getByLabel('조치 종류').fill('압축기 밸브 교체');
  await form.getByLabel(/^수행일시/).fill(P3_INPUTS.valveReplacedAt);
  await form.getByLabel('검증 지표').selectOption('comp.sec_kwh_per_kg');
  await expect(form.getByLabel('기대 방향')).toHaveValue('decrease');
  await form.getByLabel(/^최소 변화량/).fill('0.05');
  await form.getByLabel('안정화 일수').fill('1');
  await form.getByRole('button', { name: '조치 등록' }).click();
  const registered = form.getByRole('status').filter({ hasText: /조치 #\d+을\(를\) 등록했습니다/ });
  await expect(registered).toBeVisible();
  const actionId = /조치 #(\d+)/.exec((await registered.textContent()) ?? '')?.[1] ?? '';

  await page.goto(`/actions/${actionId}`);
  await page.getByRole('button', { name: '검증만 실행' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^검증 실행 #\d+: 개선 확인\.$/ })).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await page.reload();
  await expect(panel(page, '압축기 밸브 교체')).toContainText('개선 확인');
  await expect(panel(page, '전후 비교')).toContainText(/−\d+\.\d+ kWh\/kg95% CI −\d+\.\d+ ~ −\d+\.\d+/);
  await page.goto('/actions');
  const row = page.getByRole('region', { name: '조치 목록 표' }).locator('tbody tr', { hasText: '압축기 밸브 교체' });
  await expect(row).toContainText('개선 확인');
});

test('(8) 비로그인: /data/readiness·/settings/detectors는 로그인으로, /api/readiness.csv는 401, 가로챈 설정 저장 Server Action 재전송도 버전을 만들지 못한다', async ({ page, playwright }) => {
  await page.goto(configPath);
  await expect(versionRows(page)).toHaveCount(2);
  const saveAction = await captureServerAction(page, configPath, () => saveResidualPct(page, '4'));

  const anonymous = await playwright.request.newContext({ baseURL: E2E_BASE_URL, storageState: SIGNED_OUT });
  try {
    for (const href of [`/data/readiness?site=${P3_SITE}`, '/settings/detectors', configPath]) {
      const response = await anonymous.get(href, { maxRedirects: 0 });
      expect(response.status(), href).toBe(307);
      expect(response.headers()['location'], href).toMatch(/\/login$/);
    }
    for (const cookie of [undefined, FORGED_SESSION_COOKIE]) {
      const response = await anonymous.get(`/api/readiness.csv?site=${P3_SITE}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0 });
      expect(response.status()).toBe(401);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(await response.text()).not.toContain('설비 경로');
    }
    await expectBlocked(anonymous, saveAction);
    await expectBlocked(anonymous, saveAction, FORGED_SESSION_COOKIE);
  } finally {
    await anonymous.dispose();
  }

  await page.goto(configPath);
  await expect(versionRows(page)).toHaveCount(2);
  await expect(page.getByRole('heading', { level: 3, name: /활성 버전 1/ })).toBeVisible();
});

test('(9) 수소 체인 기간을 다시 분석해도 리포트는 만들어지지 않는다 (리포트 수·승인 상태 그대로)', async ({ page }) => {
  test.slow();
  const before = await reportCount(page);
  expect(before).toBeGreaterThan(0);
  await runChainAnalysis(page);
  expect(await reportCount(page)).toBe(before);
  await expect(page.getByRole('region', { name: '리포트 목록 표' }).locator('tbody tr', { has: page.locator(`a[href="/reports/${ids.report}"]`) })).toContainText('승인');
});
