import { describe, expect, it } from 'vitest';
import { QUALITY } from '@/lib/ingest/quality';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, type Sample } from '../types';
import { extractCompressorRuns } from './compressor';
import { extractCurrentSteps } from './ess-steps';
import { extractBlowerRuns } from './fc-blower';
import { inverterThermalSamples } from './inverter-thermal';
import { extractTankHolds, tankHoldPoints } from './tank-hold';
import { T0, type MutableSeries } from './test-fixtures';
import { EXTRACTOR_VERSIONS } from './types';
import { extractWxDays } from './wx-day';

/** fn(분) → 값. step분 간격 샘플 (null이면 샘플 없음) */
function series(minutes: number, step: number, fn: (minute: number) => number | null, quality: (minute: number) => number = () => 0): Sample[] {
  return Array.from({ length: Math.floor(minutes / step) }, (_, i) => i * step).flatMap((minute) => {
    const value = fn(minute);
    return value === null ? [] : [{ ts: T0 + minute * MS_PER_MINUTE, value, quality: quality(minute) }];
  });
}

describe('P3 추출기 버전', () => {
  it('신규 에피소드 종류는 @1이다', () => {
    expect([EXTRACTOR_VERSIONS['comp.run'], EXTRACTOR_VERSIONS['tank.hold'], EXTRACTOR_VERSIONS['fc.blower_run'], EXTRACTOR_VERSIONS['wx.day'], EXTRACTOR_VERSIONS['ess.current_step']]).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('comp.run@1', () => {
  // 0~60분 정지, 60~240분 운전(15 kW), 240~300분 정지, 300~320분 짧은 운전, 330~480분 운전 (창 끝까지)
  const running = (m: number) => (m >= 60 && m < 240) || (m >= 300 && m < 320) || m >= 330;
  const input: MutableSeries = {
    'compressor.power': series(480, 5, (m) => (running(m) ? 15 : 0.3)),
    'compressor.suction.pressure': series(480, 5, () => 30),
    'compressor.discharge.pressure': series(480, 5, (m) => 300 + m / 10),
    'compressor.discharge.temp': series(480, 5, (m) => (running(m) ? 90 : 25)),
    'compressor.leak.pressure': series(480, 5, (m) => (m === 120 ? 0.4 : 0.05)),
    'h2.flow.mass': series(480, 5, (m) => (running(m) ? 7.5 : 0)),
    'ambient.temp': series(480, 5, () => 21),
    'run.hours': series(480, 5, (m) => 100 + m / 60),
  };

  it('운전 구간마다 전력량·이송 질량·비에너지·압력비·후반 토출 온도·누설 감지 최댓값을 만든다', () => {
    const runs = extractCompressorRuns({ assetId: 5, window: { start: T0, end: T0 + 480 * MS_PER_MINUTE }, series: input, nameplate: { rated_kw: 45 } });
    expect(runs).toHaveLength(2);
    const [first, last] = runs;
    expect(first).toMatchObject({ kind: 'comp.run', extractorVersion: 'comp.run@1', valid: true, open: false, start: T0 + 60 * MS_PER_MINUTE, end: T0 + 240 * MS_PER_MINUTE });
    expect(first?.features.energy_kwh).toBeCloseTo(45, 1);
    expect(first?.features.mass_kg).toBeCloseTo(22.5, 1);
    expect(first?.features.sec_kwh_per_kg).toBeCloseTo(2, 2);
    expect(first?.features.mass_source).toBe('flow');
    expect(first?.features.pressure_ratio).toBeCloseTo((300 + 14.75) / 30, 1);
    expect(first?.features.discharge_temp_c).toBe(90);
    expect(first?.features.leak_pressure_max_bar).toBe(0.4);
    expect(first?.conditions).toEqual({ ratio_bin: 10, t_bin: 20 });
    expect(last).toMatchObject({ open: true, valid: false, invalidReason: 'open' });
  });

  it('유량계가 없으면 저장뱅크 재고 증가로 이송 질량을 잰다, 정격이 없으면 오류', () => {
    const noFlow = { ...input, 'h2.flow.mass': [], 'h2.inventory': series(480, 5, (m) => 100 + 7.5 * Math.max(0, Math.min(m, 240) - 60) / 60) };
    const [run] = extractCompressorRuns({ assetId: 5, window: { start: T0, end: T0 + 480 * MS_PER_MINUTE }, series: noFlow, nameplate: { rated_kw: 45 } });
    expect(run?.features.mass_source).toBe('inventory');
    expect(run?.features.mass_kg).toBeCloseTo(22.5, 0);
    const none = { ...noFlow, 'h2.inventory': [] };
    expect(extractCompressorRuns({ assetId: 5, window: { start: T0, end: T0 + 480 * MS_PER_MINUTE }, series: none, nameplate: { rated_kw: 45 } })[0]?.features).toMatchObject({ mass_kg: null, sec_kwh_per_kg: null });
    expect(() => extractCompressorRuns({ assetId: 5, window: { start: T0, end: T0 + MS_PER_HOUR }, series: input, nameplate: { rated_kw: 0 } })).toThrow(RangeError);
  });
});

describe('tank.hold@1', () => {
  // 0~120분 충전(밸브 열림·압축기 운전), 120~720분 정지, 720~780분 방출
  const flowing = (m: number) => m < 120 || m >= 720;
  const input: MutableSeries = {
    'tank.pressure': series(900, 5, (m) => 300 - m / 1000),
    'tank.temp': series(900, 5, (m) => 25 - m / 120),
    'valve.open#inlet': series(900, 5, (m) => (m < 120 ? 1 : 0)),
    'valve.open#outlet': series(900, 5, (m) => (m >= 720 && m < 780 ? 1 : 0)),
    'compressor.power': series(900, 5, (m) => (m < 120 ? 15 : 0.3)),
    'fc.h2.consumption': series(900, 5, (m) => (m >= 720 && m < 780 ? 5 : 0)),
    'h2.pressure': series(900, 5, (m) => (flowing(m) ? 8 : 2 + m / 600)),
  };

  it('유입·유출이 없는 구간에서 안정화 시간을 잘라 정지 보유 구간을 만들고(창 끝에 걸린 구간은 open), 압력·온도 짝을 돌려준다', () => {
    const holds = extractTankHolds({ assetId: 71, window: { start: T0, end: T0 + 900 * MS_PER_MINUTE }, series: input, nameplate: { water_volume_l: 1850 } });
    expect(holds).toHaveLength(2);
    const [hold, tail] = holds;
    expect(tail).toMatchObject({ open: true, valid: false, start: T0 + 840 * MS_PER_MINUTE });
    expect(hold).toMatchObject({ kind: 'tank.hold', valid: true, start: T0 + 180 * MS_PER_MINUTE, end: T0 + 720 * MS_PER_MINUTE });
    expect(hold?.features.duration_s).toBe(9 * 3600);
    expect(hold?.features.n_points).toBe(108);
    expect(hold?.features.downstream_p_rise_bar).toBeGreaterThan(0.8);
    expect(hold?.conditions.t_bin).toBe(20);
    expect(tankHoldPoints(input, { start: hold?.start ?? 0, end: hold?.end ?? 0 })).toHaveLength(108);
  });

  it('유출 쪽 신호가 없으면 정지를 확정할 수 없어 빈 결과, 내용적이 없으면 오류', () => {
    const noOutflow = { ...input, 'valve.open#outlet': [], 'fc.h2.consumption': [] };
    expect(extractTankHolds({ assetId: 71, window: { start: T0, end: T0 + 900 * MS_PER_MINUTE }, series: noOutflow, nameplate: { water_volume_l: 1850 } })).toEqual([]);
    expect(() => extractTankHolds({ assetId: 71, window: { start: T0, end: T0 + MS_PER_HOUR }, series: input, nameplate: { water_volume_l: 0 } })).toThrow(RangeError);
  });
});

describe('fc.blower_run@1', () => {
  it('유량이 일정한 정상운전 구간마다 비전력·외기·운전시간을 만들고 저유량 구간은 뺀다', () => {
    const input: MutableSeries = {
      'blower.flow': series(480, 5, (m) => (m < 60 ? 20 : m < 240 ? 600 : m < 300 ? 20 : 400)),
      'blower.power': series(480, 5, (m) => (m < 60 ? 0.3 : m < 240 ? 3.6 : m < 300 ? 0.3 : 1.4)),
      'ambient.temp': series(480, 30, () => 17),
      'run.hours': series(480, 5, (m) => 5000 + m / 60),
    };
    const runs = extractBlowerRuns({ assetId: 61, window: { start: T0, end: T0 + 480 * MS_PER_MINUTE }, series: input, nameplate: { rated_kw: 15 } });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ kind: 'fc.blower_run', valid: true, conditions: { flow_bin: 600, t_bin: 15 } });
    expect(runs[0]?.features.specific_w_per_kg_h).toBeCloseTo(6, 3);
    expect(runs[1]).toMatchObject({ open: true, valid: false });
    expect(() => extractBlowerRuns({ assetId: 61, window: { start: T0, end: T0 + MS_PER_HOUR }, series: input, nameplate: { rated_kw: 0 } })).toThrow(RangeError);
    expect(() => extractBlowerRuns({ assetId: 61, window: { start: T0, end: T0 + MS_PER_HOUR }, series: input, nameplate: { rated_kw: 15 } }, { minFlowKgH: 0 })).toThrow(RangeError);
  });
});

describe('wx.day@1', () => {
  it('KST 하루마다 POA·GHI 일적산, 일사 가중 모듈 온도, 일중 변동 지표를 만든다 (맑은 날 ≈ 1, 흐린 날은 크다)', () => {
    const day = (m: number) => m % 1440;
    const sun = (m: number) => Math.max(0, Math.sin((Math.PI * (day(m) - 360)) / 720)) * 1000;
    const cloudy = (m: number) => sun(m) * (Math.floor(m / 20) % 2 === 0 ? 1 : 0.3);
    const input: MutableSeries = {
      'poa.irradiance': series(2880, 5, (m) => (m < 1440 ? sun(m) : cloudy(m))),
      'ghi.irradiance': series(2880, 5, (m) => (m < 1440 ? sun(m) : cloudy(m)) * 0.85),
      'module.temp': series(2880, 5, (m) => 20 + sun(m) / 40),
    };
    const days = extractWxDays({ assetId: 1, window: { start: T0, end: T0 + 2 * MS_PER_DAY }, series: input, nameplate: null });
    expect(days).toHaveLength(2);
    const [clear, overcast] = days;
    expect(clear).toMatchObject({ kind: 'wx.day', valid: true, open: false });
    expect(clear?.features.poa_kwh_m2).toBeCloseTo(7.64, 1);
    expect(clear?.features.ghi_kwh_m2).toBeCloseTo(7.64 * 0.85, 1);
    expect(clear?.features.tmod_weighted_c).toBeGreaterThan(35);
    expect(clear?.features.variability).toBeCloseTo(1, 1);
    expect(overcast?.features.variability).toBeGreaterThan(3);
    expect(extractWxDays({ assetId: 1, window: { start: T0, end: T0 + MS_PER_DAY }, series: {}, nameplate: null })).toEqual([]);
  });
});

describe('ess.current_step@1', () => {
  it('깨끗한 전류 계단마다 R = ΔV/ΔI, SOC·셀온도·주기를 만들고 불안정 계단·음의 R·BAD 샘플은 뺀다', () => {
    const currentAt = (m: number) => (m < 30 ? 0 : m < 60 ? 120 : m < 90 ? 0 : m < 91 ? 60 : m < 120 ? 180 : 0);
    const input: MutableSeries = {
      'batt.current': series(150, 1, currentAt, (m) => (m === 120 ? QUALITY.SPIKE : 0)),
      'batt.voltage': series(150, 1, (m) => 830 + currentAt(m) * 0.05),
      'batt.soc': series(150, 1, () => 55),
      'cell.temp.avg': series(150, 5, () => 24),
      'cell.voltage.max': series(150, 1, () => 3.31),
      'cell.voltage.min': series(150, 1, () => 3.3),
    };
    const steps = extractCurrentSteps({ assetId: 9, window: { start: T0, end: T0 + 150 * MS_PER_MINUTE }, series: input, nameplate: { capacity_ah: 600 } });
    expect(steps.map((s) => [s.start - T0, s.features.delta_i_a])).toEqual([
      [29 * MS_PER_MINUTE, 120],
      [59 * MS_PER_MINUTE, -120],
    ]);
    expect(steps[0]?.features).toMatchObject({ r_mohm: 50, period_s: 60, soc: 55, t_cell_c: 24, cell_dv_mv: 10 });
    expect(steps[0]?.conditions).toEqual({ soc_bin: 50, t_bin: 20, direction: 'up' });
    expect(() => extractCurrentSteps({ assetId: 9, window: { start: T0, end: T0 + MS_PER_HOUR }, series: input, nameplate: { capacity_ah: 0 } })).toThrow(RangeError);
  });
});

describe('inverterThermalSamples', () => {
  it('인버터마다 같은 5분 버킷으로 평균 kW/kWp·방열판·출력제한·외기를 맞추고 출력 샘플이 없는 버킷은 뺀다', () => {
    const inverter = (kw: number, limit: boolean) => ({
      'ac.power': series(30, 1, (m) => (m >= 20 ? null : kw)),
      'heatsink.temp': series(30, 5, () => 60),
      ...(limit ? { 'ac.power.limit': series(30, 5, () => 80) } : {}),
    });
    const samples = inverterThermalSamples(
      [
        { assetId: 1, dcKwp: 200, series: inverter(100, true) },
        { assetId: 2, dcKwp: 200, series: inverter(150, false) },
        { assetId: 3, dcKwp: 0, series: inverter(150, false) },
      ],
      { 'ambient.temp': series(30, 5, () => 28) },
      { start: T0, end: T0 + 30 * MS_PER_MINUTE },
    );
    expect(samples).toHaveLength(8);
    expect(samples[0]).toEqual({ ts: T0, assetId: 1, kwPerKwp: 0.5, heatsinkC: 60, limitPct: 80, ambientC: 28 });
    expect(samples[1]).toMatchObject({ assetId: 2, kwPerKwp: 0.75, limitPct: null });
  });
});
