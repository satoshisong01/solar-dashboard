import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { presetScenarios } from './presets';
import { DEMO_P3 } from './presets-demo';
import { buildTruth } from './truth';

const FROM = Date.parse('2026-05-18T10:00:00+09:00');
const ORIGIN = Date.parse('2026-05-18T00:00:00+09:00');
const TO = FROM + 120 * MS_PER_DAY;
const ALL = ['SIM-A', 'SIM-B', 'SIM-C'];
const day = (n: number, hour = 0) => ORIGIN + n * MS_PER_DAY + hour * MS_PER_HOUR;

describe('buildTruth — demo (P3 추가분)', () => {
  const truth = buildTruth({ siteCodes: ALL, from: FROM, to: TO, scenarios: presetScenarios('demo', ALL, { fromMs: FROM, toMs: TO }) });
  const p3 = truth.injections.slice(5);

  it('P3 고장 정답: 설비 경로·시작·끝·고장모드(lib/analytics FailureMode)·탐지기(설계 §5.3)·부수 탐지기', () => {
    expect(p3.map((i) => [i.assetPath, i.kind, i.startTs, i.endTs, i.expectedFailureModes, i.expectedDetectors, i.relatedDetectors ?? []])).toEqual([
      ...['PV1/INV01', 'PV1/INV02', 'PV1/INV03', 'PV1/INV04'].map((code) => [`SIM-A/${code}`, 'fault.pv_soiling', FROM, TO, ['pv.soiling'], ['pv.soiling_rate'], []]),
      ['SIM-A/ESS1/RACK02', 'fault.rack_resistance_growth', day(50), TO, ['ess.resistance_growth'], ['ess.resistance_growth'], ['ess.capacity_fade']],
      ['SIM-A/PV1/INV02', 'fault.inverter_fan_failure', day(40), TO, ['pv.inverter_thermal_derating'], ['inv.thermal_derating'], ['pv.inverter_peer']],
      ['SIM-B/H2BANK1/TANK3', 'fault.tank_leak', day(60), TO, ['h2.storage_leak'], ['tank.static_leak'], ['h2chain.mass_balance_gap']],
      ['SIM-B/COMP1', 'fault.compressor_valve_wear', day(40), TO, ['comp.efficiency_loss'], ['comp.sec_rise'], []],
      ['SIM-B/ELZ1', 'fault.elz_sec_rise', day(45), TO, ['el.system_efficiency_loss'], ['el.sec_rise'], []],
      ['SIM-B/FC1/BLOWER1', 'fault.fc_air_filter_clog', day(70), day(110, 10), ['fc.blower_wear'], ['fc.blower_wear'], []],
    ]);
  });

  it('크기 파라미터: 누설 일정(0.05 → 90일째 안전 임계 2배), 오염 복원 시각(강우일 45·75일째 03시), 필터 교체 시각', () => {
    const leak = p3.find((i) => i.kind === 'fault.tank_leak');
    const soiling = p3.find((i) => i.kind === 'fault.pv_soiling');

    expect(leak?.params).toMatchObject({ kgPerDay: 0.05, maxKgPerDay: DEMO_P3.tankLeak.escalationKgPerDay, schedule: `0.05@${day(60)};${DEMO_P3.tankLeak.escalationKgPerDay}@${day(90)}`, fullEffectTs: day(90) });
    expect(soiling?.params).toMatchObject({ pctPerDay: 0.08, rainDays: '45,75', restoreTs: `${day(45, 3)},${day(75, 3)}` });
    expect(p3.find((i) => i.kind === 'fault.elz_sec_rise')?.params).toMatchObject({ mode: 'rectifier', pct: 6, faultAsset: 'ELZ1/RECT1' });
  });

  it('대조군: SIM-C 고온 주·일교차 확대(저장뱅크)와 속기 쉬운 P3 탐지기, 운영 이벤트: 필터 교체(asset_event replacement)', () => {
    expect(truth.controls.filter((c) => c.kind === 'control.hot_week' || c.kind === 'control.day_night_swing').map((c) => [c.siteCode, c.assetPath, c.kind, c.startTs, c.endTs, c.confoundedDetectors])).toEqual([
      ['SIM-C', null, 'control.hot_week', day(98), day(105), ['inv.thermal_derating', 'fc.blower_wear', 'pv.soiling_rate', 'pv.inverter_peer']],
      ['SIM-C', 'SIM-C/H2BANK1', 'control.day_night_swing', day(110), day(117), ['tank.static_leak', 'h2chain.mass_balance_gap']],
    ]);
    expect(truth.assetEvents).toEqual([
      expect.objectContaining({ kind: 'setpoint_change', assetPath: 'SIM-B/ESS1' }),
      { siteCode: 'SIM-B', assetPath: 'SIM-B/FC1/BLOWER1', ts: day(110, 10), kind: 'replacement', resetsBaseline: false, note: '연료전지 공기 필터 교체' },
    ]);
  });
});

describe('buildTruth — P3 선택 항목', () => {
  it('셀 전압 경로 비에너지 상승은 el.voltage_rise를 부수 탐지기로, 세척은 asset_event(maintenance), 비 오는 주는 오염 복원 시각에 들어간다', () => {
    const to = FROM + 60 * MS_PER_DAY;
    const truth = buildTruth({
      siteCodes: ['SIM-A', 'SIM-B', 'SIM-C'],
      from: FROM,
      to,
      scenarios: [
        { kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'stack', pct: 5, startDay: 1 },
        { kind: 'fault.pv_soiling', site: 'SIM-A', asset: 'PV1/INV03', pctPerDay: 0.1, startDay: 1, cleaningDay: 40 },
        { kind: 'control.rainy_week', site: 'SIM-A', startDay: 20 },
        { kind: 'control.healthy_mass_balance', site: 'SIM-C', startDay: 5, days: 30 },
        { kind: 'control.tank_refill_topoff', site: 'SIM-C', startDay: 40 },
      ],
    });

    expect(truth.injections.find((i) => i.kind === 'fault.elz_sec_rise')?.relatedDetectors).toEqual(['el.voltage_rise']);
    expect(truth.injections.find((i) => i.kind === 'fault.pv_soiling')?.params.restoreTs).toBe([...Array.from({ length: 7 }, (_, i) => day(20 + i, 4)), day(40, 10)].join(','));
    expect(truth.assetEvents).toEqual([{ siteCode: 'SIM-A', assetPath: 'SIM-A/PV1', ts: day(40, 10), kind: 'maintenance', resetsBaseline: false, note: '태양광 모듈 세척' }]);
    expect(truth.controls.map((c) => [c.kind, c.assetPath, c.params])).toEqual([
      ['control.rainy_week', null, { heavyRainWindows: 7 }],
      ['control.tank_refill_topoff', 'SIM-C/H2BANK1', { nightlyRuns: 7 }],
      ['control.healthy_mass_balance', null, { maxResidualPct: 1 }],
    ]);
  });
});
