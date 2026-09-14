import { describe, expect, it } from 'vitest';
import { ASSET_CLASSES, ASSET_CLASS_BY_KEY, METRIC_DEFS } from './catalog';

const METRIC_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/; // om.metric_def CHECK와 같은 규칙

/** 과제에서 이름을 지정한 메트릭 키 */
const REQUIRED_METRIC_KEYS = [
  'dc.voltage', 'dc.current', 'ac.power', 'ac.energy.total', 'poa.irradiance', 'module.temp', 'ambient.temp',
  'batt.soc', 'batt.current', 'batt.voltage', 'cell.voltage.max', 'cell.voltage.min', 'cell.voltage.avg',
  'cell.temp.max', 'cell.temp.avg', 'insulation.resistance', 'stack.voltage', 'stack.current', 'stack.temp',
  'h2.flow.mass', 'h2.purity', 'o2.in.h2', 'water.conductivity', 'rectifier.efficiency', 'compressor.power',
  'compressor.discharge.temp', 'tank.pressure', 'tank.temp', 'gas.detector.ppm', 'fc.ac.power',
  'fc.h2.consumption', 'fc.coolant.temp.in', 'fc.coolant.temp.out', 'blower.power', 'blower.flow', 'purge.count',
];

const REQUIRED_ASSET_CLASS_KEYS = ['pv.inverter', 'ess.rack', 'h2.elz.stack', 'h2.compressor', 'h2.storage.bank', 'fc.stack'];

describe('METRIC_DEFS', () => {
  it('키가 유일하고 명명 규칙을 따르며 60~90개다', () => {
    const keys = METRIC_DEFS.map((metric) => metric.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => !METRIC_KEY_PATTERN.test(key))).toEqual([]);
    expect(keys.length).toBeGreaterThanOrEqual(60);
    expect(keys.length).toBeLessThanOrEqual(90);
  });

  it('과제에서 지정한 메트릭을 모두 담는다', () => {
    const keys = new Set(METRIC_DEFS.map((metric) => metric.key));

    expect(REQUIRED_METRIC_KEYS.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('범위는 min ≤ max이고 전형 범위는 물리 한계 안에 있다', () => {
    for (const metric of METRIC_DEFS) {
      const { key, hardMin, hardMax, expectedMin, expectedMax } = metric;
      if (hardMin !== null && hardMax !== null) expect(hardMin, key).toBeLessThan(hardMax);
      if (expectedMin !== null && expectedMax !== null) expect(expectedMin, key).toBeLessThanOrEqual(expectedMax);
      if (hardMin !== null && expectedMin !== null) expect(expectedMin, key).toBeGreaterThanOrEqual(hardMin);
      if (hardMax !== null && expectedMax !== null) expect(expectedMax, key).toBeLessThanOrEqual(hardMax);
    }
  });

  it('값 종류에 맞는 롤업 방식을 쓴다', () => {
    for (const metric of METRIC_DEFS) {
      if (metric.valueKind === 'counter') expect(['delta', 'last'], metric.key).toContain(metric.rollup);
      if (metric.valueKind === 'state' || metric.valueKind === 'bool') expect(metric.rollup, metric.key).toBe('last');
      if (metric.valueKind === 'gauge') expect(metric.rollup, metric.key).not.toBe('delta');
    }
  });
});

describe('ASSET_CLASSES', () => {
  it('키가 유일하고 과제에서 지정한 설비 종류를 담는다', () => {
    const keys = ASSET_CLASSES.map((assetClass) => assetClass.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(REQUIRED_ASSET_CLASS_KEYS.filter((key) => !ASSET_CLASS_BY_KEY.has(key))).toEqual([]);
  });

  it('parent_key는 존재하는 설비 종류를 가리킨다', () => {
    const dangling = ASSET_CLASSES.filter((c) => c.parentKey !== null && !ASSET_CLASS_BY_KEY.has(c.parentKey));

    expect(dangling.map((c) => c.key)).toEqual([]);
  });

  it('명판 스키마의 필수 필드는 properties에 정의돼 있다', () => {
    for (const { key, nameplateSchema } of ASSET_CLASSES) {
      const properties = Object.keys(nameplateSchema.properties);
      expect(nameplateSchema.required.filter((field) => !properties.includes(field)), key).toEqual([]);
    }
  });

  it('안전 이벤트 코드는 대문자 스네이크이고 핵심 코드가 등록돼 있다', () => {
    const codes = ASSET_CLASSES.flatMap((assetClass) => assetClass.safetyEventCodes);

    expect(codes.filter((code) => !/^[A-Z][A-Z0-9_]*$/.test(code))).toEqual([]);
    expect(codes).toEqual(expect.arrayContaining(['ESD', 'CELL_OVERVOLT', 'INSULATION_FAULT']));
    expect(codes.some((code) => code.startsWith('H2_LEAK_'))).toBe(true);
    expect(codes.some((code) => code.startsWith('FIRE_'))).toBe(true);
    expect(ASSET_CLASS_BY_KEY.get('h2.detector')?.safetyEventCodes).toEqual(
      expect.arrayContaining(['H2_LEAK_L1', 'H2_LEAK_L2']),
    );
  });
});
