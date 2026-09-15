import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { LEMMON_EOS } from '../detectors/hydrogen-eos';
import { DAY0, DQ_FULL } from '../detectors/test-fixtures';
import type { EssStepEpisode } from '../episodes/ess-steps';
import type { TankHoldEpisode, TankHoldPoint } from '../episodes/tank-hold';
import type { H2Ledger } from '../ledger/types';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../types';
import { runSiteDetectors } from './detect';
import { rectifierEfficiencyDays, tankHoldWindows, TANK_WINDOW_PADDING_MS, thermalSampleWindow, type HourStat } from './load-plans';
import { buildLedgerDays, completeKstDays, kstDayMs, ledgerDayRowOf, massBalanceDays, referencePrOf, soilingFractionsByDay, type LedgerDayRow } from './site-ledger';
import type { SiteSnapshot } from './snapshot';
import { EPISODE_KINDS, seriesRequests } from './sources';
import type { DetectorOutcome, PipelineAsset } from './types';

const DAYS = 60;
const FIRST_DAY = kstDayStart(DAY0);
const NOW = FIRST_DAY + DAYS * MS_PER_DAY;

const asset = (id: number, code: string, classKey: string, extra: Partial<PipelineAsset> = {}): PipelineAsset => ({ id, siteId: 3, parentId: null, code, classKey, peerGroup: null, nameplate: {}, commissionedAt: null, ...extra });

const SITE: readonly PipelineAsset[] = [
  asset(1, 'ELZ1', 'h2.elz'),
  asset(2, 'ELZ1/STACK1', 'h2.elz.stack', { parentId: 1, nameplate: { cell_count: 210, active_area_cm2: 550, rated_current_a: 1100 } }),
  asset(3, 'ELZ1/RECT1', 'h2.elz.rectifier', { parentId: 1 }),
  asset(10, 'COMP1', 'h2.compressor', { nameplate: { rated_kw: 45 } }),
  asset(20, 'H2BANK1', 'h2.storage.bank'),
  asset(21, 'H2BANK1/TANK1', 'h2.storage.tank', { parentId: 20, nameplate: { water_volume_l: 1850 } }),
  asset(30, 'FC1', 'fc.plant'),
  asset(31, 'FC1/STACK1', 'fc.stack', { parentId: 30, nameplate: { cell_count: 400, active_area_cm2: 800, rated_current_a: 820 } }),
  asset(32, 'FC1/BLOWER1', 'fc.blower', { parentId: 30, nameplate: { rated_kw: 15 } }),
  asset(40, 'WX1', 'wx.station'),
  asset(50, 'PV1', 'pv.plant'),
  ...[51, 52, 53].map((id, i) => asset(id, `PV1/INV0${i + 1}`, 'pv.inverter', { parentId: 50, nameplate: { ac_kw: 250, dc_kwp: 250 } })),
  asset(60, 'ESS1/RACK01', 'ess.rack', { nameplate: { capacity_ah: 600 } }),
];

/** 매일 밤 8시간 정지 보유 (질량은 누설만큼 줄고 야간에 식는다, 압력은 NIST 상태식 역산) */
function tankHolds(leakFromDay: number, kgPerDay: number): { episodes: TankHoldEpisode[]; points: Map<number, TankHoldPoint[]> } {
  const rng = createRng(5);
  const episodes: TankHoldEpisode[] = [];
  const points = new Map<number, TankHoldPoint[]>();
  let mass = 45;
  for (let day = 0; day < DAYS - 1; day += 1) {
    const start = FIRST_DAY + day * MS_PER_DAY + 13 * MS_PER_HOUR;
    const leak = day >= leakFromDay ? kgPerDay : 0;
    const hold = Array.from({ length: 96 }, (_, k) => {
      const t = k * 5 * MS_PER_MINUTE;
      const tempC = 18 - 4 * (1 - Math.exp(-t / (3 * MS_PER_HOUR)));
      return { ts: start + t, pressureBar: LEMMON_EOS.pressure(mass - (leak * t) / MS_PER_DAY, tempC, 1.85) + 0.05 * rng.gaussian(), tempC: tempC + 0.05 * rng.gaussian() };
    });
    mass = mass - leak / 3 + 0.2;
    points.set(start, hold);
    const features = { duration_s: 8 * 3600, settle_s: 3600, n_points: hold.length, p_start_bar: null, p_end_bar: null, p_mean_bar: null, t_mean_c: null, t_min_c: null, t_max_c: null, downstream_p_rise_bar: 0 };
    episodes.push({ assetId: 21, kind: 'tank.hold', extractorVersion: 'tank.hold@1', start, end: start + 8 * MS_PER_HOUR, features, conditions: { t_bin: 15 }, dq: DQ_FULL, open: false, valid: true, invalidReason: null });
  }
  return { episodes, points };
}

function ledgerRow(day: number, residualPct: number): LedgerDayRow {
  const produced = 50;
  const residual = (produced * residualPct) / 100;
  const h2: H2Ledger = { produced, fc_consumed: 40, stored_delta: 10 - residual, vented_est: 0, residual, residual_pct: residualPct, method: { produced: 'meter', fc_consumed: 'meter', stored_delta: 'lemmon2008@1', vented: 'not_estimated' }, aux: { faraday_expected: 51, purge_count: 20, tank_temp_delta_c: 0.5 } };
  return { dayStart: FIRST_DAY + day * MS_PER_DAY, h2, h2Completeness: 1 };
}

const snapshotOf = (extra: Partial<SiteSnapshot> = {}): SiteSnapshot => ({ siteId: 3, assets: SITE, episodes: [], events: [], configs: [], ...extra });

describe('P3 추출 입력 규칙', () => {
  it('압축기·저장용기·블로워·기상 설비의 시계열 요청과 에피소드 종류', () => {
    const tank = SITE.find((a) => a.id === 21) as PipelineAsset;
    expect(seriesRequests(tank, SITE)).toEqual([
      { assetId: 21, metricKey: 'tank.pressure' },
      { assetId: 21, metricKey: 'tank.temp' },
      { assetId: 20, metricKey: 'valve.open#inlet' },
      { assetId: 20, metricKey: 'valve.open#outlet' },
      { assetId: 10, metricKey: 'compressor.power' },
      { assetId: 1, metricKey: 'h2.flow.mass' },
      { assetId: 30, metricKey: 'fc.h2.consumption' },
      { assetId: 30, metricKey: 'h2.pressure' },
    ]);
    expect(seriesRequests(SITE.find((a) => a.id === 32) as PipelineAsset, SITE)).toContainEqual({ assetId: 31, metricKey: 'run.hours' });
    expect(EPISODE_KINDS['ess.rack']).toContain('ess.current_step');
    expect(EPISODE_KINDS['wx.station']).toEqual(['wx.day']);
  });
});

describe('P3 탐지기 실행 (runSiteDetectors)', () => {
  it('저장용기 누설 → 물질수지가 같은 실행의 누설 결과를 판별 체크에 쓴다 (사이트 단위 finding, assetId null)', () => {
    const { episodes, points } = tankHolds(30, 0.8);
    const ledgerDays = Array.from({ length: DAYS }, (_, day) => ledgerRow(day, day >= 30 ? 3.5 + 0.1 * Math.sin(day) : 0.1 * Math.sin(day)));
    const outcomes = runSiteDetectors(snapshotOf({ episodes, aux: { tankHoldPoints: new Map([[21, points]]), ledgerDays } }), { now: NOW, seed: 1, detectorIds: ['tank.static_leak', 'h2chain.mass_balance_gap'] });
    const leak = outcomes.find((o) => o.detectorId === 'tank.static_leak');
    expect(leak).toMatchObject({ status: 'ok', assetId: 21 });
    expect(leak?.findings[0]?.effect.value).toBeGreaterThan(0.6);
    const chain = outcomes.find((o) => o.detectorId === 'h2chain.mass_balance_gap');
    expect(chain).toMatchObject({ status: 'ok', assetId: null });
    expect(chain?.findings[0]).toMatchObject({ assetId: null, failureMode: 'h2chain.mass_balance_gap' });
    const checks = (chain?.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[];
    expect(checks.find((c) => c.id === 'storage_leak')?.status).toBe('supports');
    // 원장 일 행이 없으면 물질수지는 실행하지 않고, 정지 구간 원시 점이 없으면 누설은 판정 불능
    const bare = runSiteDetectors(snapshotOf({ episodes }), { now: NOW, seed: 1, detectorIds: ['tank.static_leak', 'h2chain.mass_balance_gap'] });
    expect(bare.map((o) => [o.detectorId, o.status])).toEqual([['tank.static_leak', 'insufficient']]);
    // 앞 단계 결과(priorOutcomes)로도 교차 확인한다
    const second = runSiteDetectors(snapshotOf({ aux: { ledgerDays } }), { now: NOW, seed: 1, detectorIds: ['h2chain.mass_balance_gap'], priorOutcomes: outcomes.filter((o) => o.detectorId === 'tank.static_leak') });
    expect(((second[0]?.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).find((c) => c.id === 'storage_leak')?.status).toBe('supports');
  });

  it('랙 저항은 같은 실행의 용량 결과를, 사이트 단위 오염·열 저감은 pv.plant·동종 인버터 기준으로 입력을 만든다', () => {
    const rng = createRng(3);
    const steps: EssStepEpisode[] = Array.from({ length: 60 * 5 }, (_, i) => {
      const start = FIRST_DAY + i * 4.8 * MS_PER_HOUR;
      const r = 40 * (i > 150 ? 1.5 : 1) * (1 + 0.01 * rng.gaussian());
      return { assetId: 60, kind: 'ess.current_step', extractorVersion: 'ess.current_step@1', start, end: start + 60_000, features: { r_mohm: r, delta_i_a: 90, delta_i_c: 0.15, delta_v_v: 3.6, i_before_a: 0, i_after_a: 90, soc: 50, t_cell_c: 25, period_s: 60, cell_dv_mv: 8 }, conditions: { soc_bin: 50, t_bin: 25, direction: 'up' }, dq: DQ_FULL, open: false, valid: true, invalidReason: null };
    });
    const prior: DetectorOutcome = { detectorId: 'ess.capacity_fade', detectorVersion: '1', siteId: 3, assetId: 60, status: 'ok', findings: [], reason: null, configVersions: [], config: { scope: 'code_default', version: null, paramsHash: 'x', applied: [] } };
    const outcomes = runSiteDetectors(snapshotOf({ episodes: steps }), { now: NOW, seed: 1, detectorIds: ['ess.resistance_growth', 'pv.soiling_rate', 'inv.thermal_derating', 'el.sec_rise', 'comp.sec_rise', 'fc.blower_wear'], priorOutcomes: [prior] });
    const resistance = outcomes.find((o) => o.detectorId === 'ess.resistance_growth');
    expect(resistance?.findings[0]?.effect.value).toBeGreaterThan(40);
    expect(((resistance?.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).find((c) => c.id === 'capacity_fade')?.status).toBe('refutes');
    expect(outcomes.find((o) => o.detectorId === 'pv.soiling_rate')).toMatchObject({ assetId: null, status: 'insufficient', config: { scope: 'code_default' } });
    expect(outcomes.find((o) => o.detectorId === 'inv.thermal_derating')).toMatchObject({ assetId: null, status: 'insufficient' });
    expect(outcomes.filter((o) => ['el.sec_rise', 'comp.sec_rise', 'fc.blower_wear'].includes(o.detectorId)).map((o) => [o.detectorId, o.assetId, o.status])).toEqual([
      ['el.sec_rise', 2, 'insufficient'],
      ['comp.sec_rise', 10, 'insufficient'],
      ['fc.blower_wear', 32, 'insufficient'],
    ]);
    // 대상 설비에 PV·수소 체인 설비가 없으면 사이트 단위 탐지기는 실행하지 않는다
    expect(runSiteDetectors(snapshotOf({ aux: { ledgerDays: [] } }), { now: NOW, seed: 1, targetAssetIds: new Set([60]), detectorIds: ['pv.soiling_rate', 'inv.thermal_derating', 'h2chain.mass_balance_gap'] })).toEqual([]);
  });
});

describe('체인 원장 조립 (site-ledger)', () => {
  it('끝난 KST 날짜·날짜 문자열·물질수지 입력 변환', () => {
    expect(completeKstDays({ start: FIRST_DAY + 3 * MS_PER_HOUR, end: FIRST_DAY + 2 * MS_PER_DAY + MS_PER_HOUR })).toEqual([FIRST_DAY, FIRST_DAY + MS_PER_DAY]);
    expect(kstDayMs('2026-01-01')).toBe(FIRST_DAY);
    const row = ledgerRow(0, 2);
    expect(massBalanceDays([row])).toEqual([{ day: FIRST_DAY, produced: 50, fc_consumed: 40, stored_delta: 9, vented_est: 0, residual: 1, residual_pct: 2, dq: { completeness: 1 }, faraday_expected: 51, purge_count: 20, tank_temp_delta_c: 0.5 }]);
  });

  it('데이터가 없는 날은 원장을 만들지 않고, 만든 날은 원장 일 행으로 되돌릴 수 있다', () => {
    const assets = [{ id: 1, code: 'MTR1', classKey: 'grid.meter', nameplate: {} }];
    const rows = [{ assetId: 1, metricKey: 'ac.power', hourStart: FIRST_DAY + MS_PER_DAY + 5 * MS_PER_HOUR, periodS: 300, n: 12, nGood: 12, avg: -50, first: -50, last: -50 }];
    const days = buildLedgerDays({ assets, rows, dayStarts: [FIRST_DAY, FIRST_DAY + MS_PER_DAY], prRef: null });
    expect(days.map((d) => d.day)).toEqual(['2026-01-02']);
    expect(days[0]?.energy_kwh.grid_import).toBe(50);
    expect(ledgerDayRowOf(days[0] as never)).toMatchObject({ dayStart: FIRST_DAY + MS_PER_DAY, h2Completeness: null });
    expect(referencePrOf(assets, rows, null)).toBeNull();
  });

  it('오염 finding의 속도로 무세척 구간 안 날짜별 인버터 손실률을 채운다', () => {
    const finding = { windowStart: FIRST_DAY, windowEnd: FIRST_DAY + 10 * MS_PER_DAY, evidence: { rate_pct_per_day: 0.2 } } as never;
    const map = soilingFractionsByDay(finding, [51, 52], [FIRST_DAY + 4 * MS_PER_DAY, FIRST_DAY + 20 * MS_PER_DAY]);
    expect([...map.keys()]).toEqual([FIRST_DAY + 4 * MS_PER_DAY]);
    expect(map.get(FIRST_DAY + 4 * MS_PER_DAY)?.get(52)).toBeCloseTo(0.009, 9);
    expect(soilingFractionsByDay(null, [51], [FIRST_DAY]).size).toBe(0);
  });
});

describe('원시 부분 로드 규칙 (load-plans)', () => {
  const hour = (metricKey: string, h: number, min: number, max: number, nGood = 12): HourStat => ({ metricKey, hourStart: FIRST_DAY + h * MS_PER_HOUR, nGood, min, max, avg: (min + max) / 2 });
  const window = { start: FIRST_DAY, end: FIRST_DAY + 12 * MS_PER_HOUR };

  it('유입·유출 신호가 모두 멈춘 시간에 앞뒤 2시간을 붙여 합친다, 한쪽 신호가 없으면 빈 배열', () => {
    const hours = Array.from({ length: 12 }, (_, h) => [hour('compressor.power', h, 0, h === 3 || h === 7 ? 30 : 0.5), hour('fc.h2.consumption', h, 0, 0.01, h === 9 ? 0 : 12)]).flat();
    const present = new Set(['compressor.power', 'fc.h2.consumption']);
    const windows = tankHoldWindows(hours, present, window);
    // 정지 시간: 0~2, 4~6, 8, 10~11 (9시는 good 샘플 없음) → 패딩 2시간 뒤 모두 겹쳐 하나
    expect(windows).toEqual([{ start: window.start, end: window.end }]);
    expect(tankHoldWindows(hours.filter((h) => h.hourStart >= FIRST_DAY + 10 * MS_PER_HOUR), present, window)).toEqual([{ start: FIRST_DAY + 8 * MS_PER_HOUR, end: window.end }]);
    expect(tankHoldWindows(hours, new Set(['compressor.power']), window)).toEqual([]);
    expect(TANK_WINDOW_PADDING_MS).toBe(2 * MS_PER_HOUR);
  });

  it('정류기 효율 일 중앙값(한 시간 내내 운전한 시간만)·열 저감 표본 창', () => {
    const rows = [
      { hourStart: FIRST_DAY + 10 * MS_PER_HOUR, nGood: 12, min: 94, avg: 95 },
      { hourStart: FIRST_DAY + 11 * MS_PER_HOUR, nGood: 12, min: 0, avg: 60 },
      { hourStart: FIRST_DAY + 12 * MS_PER_HOUR, nGood: 12, min: 93, avg: 94 },
      { hourStart: FIRST_DAY + 13 * MS_PER_HOUR, nGood: 0, min: null, avg: null },
    ];
    expect(rectifierEfficiencyDays(rows)).toEqual([{ ts: FIRST_DAY + MS_PER_DAY / 2, value: 94.5 }]);
    expect(thermalSampleWindow(NOW + 5 * MS_PER_HOUR, 30)).toEqual({ start: NOW - 90 * MS_PER_DAY, end: NOW + 5 * MS_PER_HOUR });
  });
});
