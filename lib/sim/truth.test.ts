import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { presetScenarios } from './presets';
import { buildTruth } from './truth';

const FROM = Date.parse('2026-05-18T10:00:00+09:00');
const ORIGIN = Date.parse('2026-05-18T00:00:00+09:00');
const TO = FROM + 120 * MS_PER_DAY;
const ALL = ['SIM-A', 'SIM-B', 'SIM-C'];
const day = (n: number, hour = 0) => ORIGIN + n * MS_PER_DAY + hour * MS_PER_HOUR;

describe('buildTruth — demo120', () => {
  const truth = buildTruth({ siteCodes: ALL, from: FROM, to: TO, scenarios: presetScenarios('demo120', ALL, { fromMs: FROM, toMs: TO }) });

  it('실행 구간과 기준일(시작 시각의 KST 0시)을 담는다', () => {
    expect(truth).toMatchObject({ fromMs: FROM, toMs: TO, originMs: ORIGIN });
  });

  it('고장 주입: 사이트 접두 설비 경로·시작 시각·고장모드·탐지기, 끝은 실행 종료', () => {
    const summary = truth.injections.map((i) => [i.siteCode, i.assetPath, i.kind, i.startTs, i.endTs, i.expectedFailureModes, i.expectedDetectors]);

    expect(summary).toEqual([
      ['SIM-A', 'SIM-A/ESS1/RACK01', 'fault.battery_capacity_fade', day(45), TO, ['ess.capacity_fade'], ['ess.capacity_fade']],
      ['SIM-A', 'SIM-A/PV1/INV01', 'fault.inverter_efficiency_drop', day(60), TO, ['pv.inverter_underperformance'], ['pv.inverter_peer']],
      ['SIM-A', 'SIM-A/ESS1/RACK03', 'fault.cell_imbalance', day(30), TO, ['ess.cell_imbalance'], ['ess.cell_imbalance']],
      ['SIM-B', 'SIM-B/ELZ1/STACK1', 'fault.elz_stack_degradation', day(30), TO, ['el.stack_voltage_degradation'], ['el.voltage_rise']],
      ['SIM-B', 'SIM-B/FC1/STACK1', 'fault.fc_voltage_decay', day(30), TO, ['fc.stack_voltage_decay'], ['fc.voltage_decay']],
    ]);
    expect(truth.injections[0]?.params).toMatchObject({ totalPct: 7, days: 30, fullEffectTs: day(75) });
    expect(truth.injections[3]?.params).toEqual({ uvPerH: 25, baselineUvPerH: 4, fullEffectTs: day(30) });
  });

  it('대조군 이벤트: 한파·흐린 주·출력제어 3회(SIM-C)와 SOC 상한 변경(SIM-B), 속기 쉬운 탐지기 포함', () => {
    const summary = truth.controls.map((c) => [c.siteCode, c.assetPath, c.kind, c.startTs, c.endTs]);

    expect(summary).toEqual([
      ['SIM-B', 'SIM-B/ESS1', 'control.soc_upper_limit_change', day(90), TO],
      ['SIM-C', null, 'control.cold_week', day(20), day(27)],
      ['SIM-C', null, 'control.cloudy_week', day(50), day(57)],
      ['SIM-C', null, 'control.curtailment', day(70, 11), day(70, 15)],
      ['SIM-C', null, 'control.curtailment', day(77, 11), day(77, 15)],
      ['SIM-C', null, 'control.curtailment', day(84, 11), day(84, 15)],
    ]);
    expect(truth.controls[0]).toMatchObject({ params: { previousLimit: 0.9, newLimit: 0.8 }, confoundedDetectors: ['ess.capacity_fade'] });
    expect(truth.controls.find((c) => c.kind === 'control.curtailment')?.confoundedDetectors).toEqual(['pv.inverter_peer']);
  });

  it('운영 이벤트: SOC 상한 변경은 asset_event(setpoint_change)로 넣고 기준선은 나누지 않는다', () => {
    expect(truth.assetEvents).toEqual([
      { siteCode: 'SIM-B', assetPath: 'SIM-B/ESS1', ts: day(90), kind: 'setpoint_change', resetsBaseline: false, note: 'EMS 충전 SOC 상한 90% → 80%' },
    ]);
  });
});

describe('buildTruth — 데이터 품질·원시 hook·검증', () => {
  it('dq 프리셋은 단절·고착·스파이크·시계 오차·누출 경보를 정답으로 남긴다 (중복 배치는 저장값을 바꾸지 않아 제외)', () => {
    const from = Date.parse('2026-08-15T00:00:00Z');
    const to = from + 30 * MS_PER_DAY;
    const truth = buildTruth({ siteCodes: ALL, from, to, scenarios: presetScenarios('dq', ALL, { fromMs: from, toMs: to }) });

    expect(truth.injections.map((i) => [i.siteCode, i.kind, i.assetPath])).toEqual([
      ['SIM-A', 'dq.stuck_sensor', 'SIM-A/WX1'],
      ['SIM-A', 'dq.clock_skew', null],
      ['SIM-B', 'dq.gateway_outage', null],
      ['SIM-B', 'dq.spike', 'SIM-B/H2BANK1/TANK1'],
      ['SIM-B', 'safety.h2_leak_alarm', 'SIM-B/GD3'],
    ]);
    expect(truth.injections.find((i) => i.kind === 'dq.stuck_sensor')?.expectedDetectors).toEqual(['dq.gap_flatline']);
    expect(truth.controls).toEqual([]);
  });

  it('원시 hook(fault)은 대상 설비마다 한 행, 파라미터로 고장모드를 정한다', () => {
    const truth = buildTruth({ siteCodes: ['SIM-B'], from: FROM, to: TO, scenarios: [{ kind: 'fault', site: 'SIM-B', param: 'storage.leakKgPerDay', value: () => 0.5 }] });

    expect(truth.injections).toEqual([
      { siteCode: 'SIM-B', assetPath: 'SIM-B/H2BANK1', kind: 'fault', startTs: FROM, endTs: TO, params: { param: 'storage.leakKgPerDay' }, expectedFailureModes: ['storage_leak'], expectedDetectors: [] },
    ]);
  });

  it('실행이 끝난 뒤 시작하는 고장·대조군은 거부한다', () => {
    const to = FROM + 10 * MS_PER_DAY;

    expect(() => buildTruth({ siteCodes: ['SIM-B'], from: FROM, to, scenarios: [{ kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: 30, startDay: 11 }] })).toThrow('실행 구간 밖');
    expect(() => buildTruth({ siteCodes: ['SIM-C'], from: FROM, to, scenarios: [{ kind: 'control.curtailment', site: 'SIM-C', startDay: 3, count: 2 }] })).toThrow('실행 구간 밖');
    expect(() => buildTruth({ siteCodes: ['SIM-X'], from: FROM, to, scenarios: [] })).toThrow('알 수 없는 가상 사이트');
  });
});
