// extractAssetEpisodes 라우팅 (순수): 설비 종류마다 맞는 추출기로 보내고, 명판이 틀리면 NameplateError,
// 추출 대상 종류가 아니면 빈 배열. 추출기 자체 계산은 lib/analytics/episodes 테스트가 따로 본다.
import { describe, expect, it } from 'vitest';
import { essChargeCycle, essDischarge, mergeSeries, stackProfile, T0, type MutableSeries } from '../episodes/test-fixtures';
import { MS_PER_DAY, MS_PER_MINUTE, type Sample } from '../types';
import { extractAssetEpisodes, NameplateError, nameplateNumber, stackRunningCurrentA } from './extract';
import type { PipelineAsset } from './types';

const asset = (classKey: string, nameplate: Readonly<Record<string, unknown>> = {}): PipelineAsset => ({
  id: 11,
  siteId: 1,
  parentId: null,
  code: `A/${classKey}`,
  classKey,
  peerGroup: null,
  nameplate,
  commissionedAt: T0 - MS_PER_DAY,
});

/** fn(분) → 값. step분 간격 샘플 */
const series = (minutes: number, step: number, fn: (minute: number) => number): Sample[] =>
  Array.from({ length: Math.floor(minutes / step) }, (_, i) => ({ ts: T0 + i * step * MS_PER_MINUTE, value: fn(i * step), quality: 0 }));

const window = (minutes: number) => ({ start: T0, end: T0 + minutes * MS_PER_MINUTE });
const kinds = (episodes: readonly { readonly kind: string }[]): string[] => [...new Set(episodes.map((e) => e.kind))].sort();

const STACK_NAMEPLATE = { cell_count: 210, active_area_cm2: 550, rated_current_a: 1100 };
const stackSeries = (): MutableSeries => stackProfile(T0, [{ minutes: 60, currentA: 0 }, { minutes: 300, currentA: 800 }, { minutes: 120, currentA: 0 }], { cells: 210, areaCm2: 550, startHours: 1500 });

describe('nameplateNumber', () => {
  it('문자열 숫자도 읽고, 없거나 0 이하이면 설비 경로·종류·필드를 담은 NameplateError', () => {
    expect(nameplateNumber(asset('ess.rack', { capacity_ah: '600' }), 'capacity_ah')).toBe(600);
    expect(nameplateNumber(asset('ess.rack', { capacity_ah: 400 }), 'capacity_ah')).toBe(400);
    expect(() => nameplateNumber(asset('ess.rack', {}), 'capacity_ah')).toThrow(NameplateError);
    expect(() => nameplateNumber(asset('ess.rack', { capacity_ah: 0 }), 'capacity_ah')).toThrow(/capacity_ah/);
    expect(() => nameplateNumber(asset('ess.rack', { capacity_ah: -5 }), 'capacity_ah')).toThrow(NameplateError);
    expect(() => nameplateNumber(asset('ess.rack', { capacity_ah: '   ' }), 'capacity_ah')).toThrow(NameplateError);
    expect(() => nameplateNumber(asset('ess.rack', { capacity_ah: 'x' }), 'capacity_ah')).toThrow(NameplateError);
    try {
      nameplateNumber(asset('ess.rack', {}), 'capacity_ah');
    } catch (error) {
      expect(error).toBeInstanceOf(NameplateError);
      expect((error as NameplateError).name).toBe('NameplateError');
      expect((error as NameplateError).message).toContain('A/ess.rack(ess.rack)');
    }
  });
});

describe('stackRunningCurrentA', () => {
  it('스택만 값을 주고 (기본 운전 판정 비율 × 정격), 다른 종류·명판 오류는 null', () => {
    expect(stackRunningCurrentA(asset('h2.elz.stack', STACK_NAMEPLATE))).toBeCloseTo(0.1 * 1100, 6);
    expect(stackRunningCurrentA(asset('fc.stack', { rated_current_a: 820 }), { stack: { runningFraction: 0.2 } })).toBeCloseTo(164, 6);
    expect(stackRunningCurrentA(asset('ess.rack', { rated_current_a: 800 }))).toBeNull();
    expect(stackRunningCurrentA(asset('h2.elz.stack', { rated_current_a: 0 }))).toBeNull();
    expect(stackRunningCurrentA(asset('h2.elz.stack', {}))).toBeNull();
  });
});

describe('extractAssetEpisodes 라우팅', () => {
  it('ess.rack: 충전·방전·휴지 + 전류 계단', () => {
    const input = mergeSeries(
      essChargeCycle({ start: T0, restBeforeMin: 60, chargeA: 40, ccHours: 4, taperMin: 60, restAfterMin: 60, socStartPct: 20 }),
      essDischarge(T0 + 500 * MS_PER_MINUTE, 40, 120),
    );
    const episodes = extractAssetEpisodes(asset('ess.rack', { capacity_ah: 400 }), input, window(700));
    expect(kinds(episodes)).toEqual(['ess.charge', 'ess.discharge', 'ess.rest']);
    expect(episodes.every((e) => e.assetId === 11)).toBe(true);
    expect(() => extractAssetEpisodes(asset('ess.rack'), input, window(700))).toThrow(/capacity_ah/);
    // 추출기 파라미터 재정의가 전달된다 (휴지 하한을 창보다 길게 잡으면 휴지 에피소드가 없다)
    expect(kinds(extractAssetEpisodes(asset('ess.rack', { capacity_ah: 400 }), input, window(700), { ess: { minRestS: 100_000 } }))).not.toContain('ess.rest');
  });

  it('ess.rack: 깨끗한 전류 계단이 있으면 같은 호출에서 ess.current_step도 나오고, 계단 파라미터 재정의가 전달된다', () => {
    const step: MutableSeries = {
      'batt.current': series(60, 1, (m) => (m < 30 ? 0 : 40)),
      'batt.voltage': series(60, 1, (m) => (m < 30 ? 800 : 802)),
      'batt.soc': series(60, 1, () => 50),
      'cell.temp.avg': series(60, 5, () => 25),
    };
    const rack = asset('ess.rack', { capacity_ah: 400 });
    expect(kinds(extractAssetEpisodes(rack, step, window(60)))).toContain('ess.current_step');
    // 계단 하한을 40 A(0.1 C)보다 크게 잡으면 계단이 사라진다
    expect(kinds(extractAssetEpisodes(rack, step, window(60), { essSteps: { minStepC: 0.2 } }))).not.toContain('ess.current_step');
  });

  it('pv.inverter: 일 에피소드, 명판은 ac_kw·dc_kwp 둘 다 필요', () => {
    const input: MutableSeries = {
      'ac.power': series(1440, 1, (m) => (m >= 360 && m < 1080 ? 100 : 0)),
      'ac.power.limit': series(1440, 5, () => 100),
      'op.state': series(1440, 5, (m) => (m >= 360 && m < 1080 ? 3 : 1)),
      'poa.irradiance': series(1440, 5, (m) => (m >= 360 && m < 1080 ? 600 : 0)),
    };
    const episodes = extractAssetEpisodes(asset('pv.inverter', { ac_kw: 250, dc_kwp: 250 }), input, { start: T0, end: T0 + MS_PER_DAY });
    expect(kinds(episodes)).toEqual(['pv.day']);
    expect(() => extractAssetEpisodes(asset('pv.inverter', { ac_kw: 250 }), input, { start: T0, end: T0 + MS_PER_DAY })).toThrow(/dc_kwp/);
    expect(() => extractAssetEpisodes(asset('pv.inverter', { dc_kwp: 250 }), input, { start: T0, end: T0 + MS_PER_DAY })).toThrow(/ac_kw/);
  });

  it('h2.elz.stack·fc.stack: 정상운전 + 기동. 창 앞 운전 상태(context.stackPrior)를 기동 판정에 넘긴다', () => {
    const input = stackSeries();
    const el = extractAssetEpisodes(asset('h2.elz.stack', STACK_NAMEPLATE), input, window(480));
    expect(kinds(el)).toEqual(['el.start', 'el.steady_run']);
    const fc = extractAssetEpisodes(asset('fc.stack', STACK_NAMEPLATE), input, window(480));
    expect(kinds(fc)).toEqual(['fc.start', 'fc.steady_run']);
    // 창 시작 직전까지 운전 중이었으면 꺼짐 시간이 짧아 기동으로 세지 않는다
    const warm = extractAssetEpisodes(asset('h2.elz.stack', STACK_NAMEPLATE), input, window(480), {}, { stackPrior: { lastRunningTs: T0 - MS_PER_MINUTE, offBeforeWindow: false } });
    expect(kinds(warm)).toEqual(['el.start', 'el.steady_run']);
    expect(warm.filter((e) => e.kind === 'el.start')[0]?.features).not.toEqual(el.filter((e) => e.kind === 'el.start')[0]?.features);
    for (const classKey of ['h2.elz.stack', 'fc.stack']) expect(() => extractAssetEpisodes(asset(classKey, { cell_count: 210, active_area_cm2: 550 }), input, window(480))).toThrow(/rated_current_a/);
  });

  it('h2.compressor·h2.storage.tank·fc.blower·wx.station', () => {
    const compressor: MutableSeries = {
      'compressor.power': series(480, 5, (m) => (m >= 60 && m < 300 ? 15 : 0.3)),
      'compressor.suction.pressure': series(480, 5, () => 30),
      'compressor.discharge.pressure': series(480, 5, (m) => 300 + m / 10),
      'h2.flow.mass': series(480, 5, (m) => (m >= 60 && m < 300 ? 7.5 : 0)),
      'ambient.temp': series(480, 30, () => 21),
    };
    expect(kinds(extractAssetEpisodes(asset('h2.compressor', { rated_kw: 45 }), compressor, window(480)))).toEqual(['comp.run']);
    expect(() => extractAssetEpisodes(asset('h2.compressor'), compressor, window(480))).toThrow(/rated_kw/);

    const tank: MutableSeries = {
      'tank.pressure': series(900, 5, (m) => 300 - m / 1000),
      'tank.temp': series(900, 5, (m) => 25 - m / 120),
      'valve.open#inlet': series(900, 5, (m) => (m < 120 ? 1 : 0)),
      'valve.open#outlet': series(900, 5, () => 0),
      'compressor.power': series(900, 5, (m) => (m < 120 ? 15 : 0.3)),
      'fc.h2.consumption': series(900, 5, () => 0),
    };
    expect(kinds(extractAssetEpisodes(asset('h2.storage.tank', { water_volume_l: 1850 }), tank, window(900)))).toEqual(['tank.hold']);
    expect(() => extractAssetEpisodes(asset('h2.storage.tank'), tank, window(900))).toThrow(/water_volume_l/);

    const blower: MutableSeries = {
      'blower.flow': series(480, 5, (m) => (m < 60 ? 20 : 600)),
      'blower.power': series(480, 5, (m) => (m < 60 ? 0.3 : 3.6)),
      'ambient.temp': series(480, 30, () => 17),
      'run.hours': series(480, 5, (m) => 5000 + m / 60),
    };
    expect(kinds(extractAssetEpisodes(asset('fc.blower', { rated_kw: 15 }), blower, window(480)))).toEqual(['fc.blower_run']);
    expect(() => extractAssetEpisodes(asset('fc.blower'), blower, window(480))).toThrow(/rated_kw/);

    const sun = (m: number) => Math.max(0, Math.sin((Math.PI * ((m % 1440) - 360)) / 720)) * 1000;
    const wx: MutableSeries = { 'poa.irradiance': series(1440, 5, sun), 'ghi.irradiance': series(1440, 5, (m) => sun(m) * 0.85), 'module.temp': series(1440, 5, (m) => 20 + sun(m) / 40) };
    expect(kinds(extractAssetEpisodes(asset('wx.station'), wx, { start: T0, end: T0 + MS_PER_DAY }))).toEqual(['wx.day']);
  });

  it('추출 대상 종류가 아니면 빈 배열이고 명판을 보지도 않는다', () => {
    for (const classKey of ['ess.plant', 'h2.elz', 'fc.plant', 'h2.storage.bank', 'grid.meter', 'pv.mppt']) {
      expect(extractAssetEpisodes(asset(classKey), {}, window(480))).toEqual([]);
    }
  });
});
