// 탐지기 레지스트리 계약: paramSchema(설정 UI) · requires(탐지 준비도 매트릭스) · id·고장모드 형식.
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { DETECTORS, elSecRise, essResistanceGrowth, FAST_S, P2_DETECTORS, P3_DETECTORS, SLOW_S } from './index';

interface JsonProperty {
  readonly type?: string | readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly label?: string;
  readonly unit?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
}

const propertiesOf = (schema: z.ZodType): Record<string, JsonProperty> => (z.toJSONSchema(schema, { io: 'input' }) as { properties: Record<string, JsonProperty> }).properties;

describe('탐지기 레지스트리', () => {
  it('P2 6종 + P3 8종, id·고장모드가 겹치지 않고 DB 형식이다', () => {
    expect(P2_DETECTORS).toHaveLength(6);
    expect(P3_DETECTORS.map((d) => d.id)).toEqual(['el.sec_rise', 'h2chain.mass_balance_gap', 'tank.static_leak', 'comp.sec_rise', 'fc.blower_wear', 'pv.soiling_rate', 'ess.resistance_growth', 'inv.thermal_derating']);
    expect(new Set(DETECTORS.map((d) => d.id)).size).toBe(14);
    expect(new Set(DETECTORS.map((d) => d.failureMode)).size).toBe(14);
    DETECTORS.forEach((d) => {
      expect(d.id).toMatch(/^[a-z][a-z0-9]*\.[a-z0-9_]+$/);
      expect(d.failureMode).toMatch(/^[a-z][a-z0-9]*\.[a-z0-9_]+$/);
      expect(d.version).toMatch(/^[1-9]\d*$/);
    });
  });

  it.each(DETECTORS.map((d) => [d.id, d] as const))('%s paramSchema 기본값 = defaultParams, 필드마다 label·unit·description·min·max', (_, detector) => {
    expect(detector.paramSchema.parse({})).toEqual(detector.defaultParams);
    const properties = propertiesOf(detector.paramSchema);
    expect(Object.keys(properties).sort()).toEqual(Object.keys(detector.defaultParams).sort());
    for (const [key, property] of Object.entries(properties)) {
      expect(property.label, key).toMatch(/\S/);
      expect(typeof property.unit, key).toBe('string');
      expect(property.description, key).toMatch(/\S/);
      const types = [property.type ?? []].flat();
      if (types.includes('number') || types.includes('integer')) {
        expect(property.minimum, key).toBeTypeOf('number');
        expect(property.maximum, key).toBeTypeOf('number');
        const value = property.default;
        if (typeof value === 'number') {
          expect(value, key).toBeGreaterThanOrEqual(property.minimum ?? -Infinity);
          expect(value, key).toBeLessThanOrEqual(property.maximum ?? Infinity);
        }
      }
    }
  });

  it('설정 검증: partial 스키마는 빠진 키를 허용하고 범위 밖 값을 거절한다', () => {
    for (const detector of DETECTORS) {
      const partial = detector.paramSchema.partial();
      expect(partial.safeParse({}).success).toBe(true);
      const [key, property] = Object.entries(propertiesOf(detector.paramSchema)).find(([, p]) => typeof p.maximum === 'number') ?? [];
      expect(key).toBeDefined();
      expect(partial.safeParse({ [key as string]: (property?.maximum ?? 0) + 1 }).success).toBe(false);
    }
  });

  it('requires: 설비 종류·메트릭은 카탈로그에 있고, 메트릭마다 주기 상한이 채워져 있다', () => {
    for (const detector of DETECTORS) {
      const { assetClass, metrics, minHistoryDays } = detector.requires;
      assetClass.forEach((key) => expect(ASSET_CLASS_BY_KEY.has(key), `${detector.id} ${key}`).toBe(true));
      for (const metric of metrics) {
        expect(METRIC_DEF_BY_KEY.has(metric.key), `${detector.id} ${metric.key}`).toBe(true);
        expect(metric.maxPeriodS === null || metric.maxPeriodS > 0, `${detector.id} ${metric.key}`).toBe(true);
      }
      expect(new Set(metrics.map((m) => m.key)).size, `${detector.id} 메트릭 중복`).toBe(metrics.length);
      expect(minHistoryDays).toBeGreaterThanOrEqual(1);
      if (detector.id !== 'dq.gap_flatline') {
        expect(assetClass.length).toBeGreaterThan(0);
        expect(metrics.filter((m) => m.optional !== true).length, `${detector.id} 필수 메트릭`).toBeGreaterThan(0);
      }
    }
  });

  it('주기 상한은 전기적 순시값 60초·그 밖 300초 두 값만 쓰고, 스택·랙 전압·전류만 60초다', () => {
    const fast = DETECTORS.flatMap((d) => d.requires.metrics.filter((m) => m.maxPeriodS === FAST_S).map((m) => `${d.id}:${m.key}`));
    for (const detector of DETECTORS) for (const metric of detector.requires.metrics) expect([FAST_S, SLOW_S], `${detector.id} ${metric.key}`).toContain(metric.maxPeriodS);
    expect(new Set(fast.map((entry) => entry.split(':')[1]))).toEqual(new Set(['stack.current', 'stack.voltage', 'batt.current', 'batt.voltage', 'batt.soc', 'cell.voltage.max', 'cell.voltage.min']));
    // 용량 감소만 SOC·셀 전압을 빠르게 받는다 (앵커 판정). 내부저항은 전압·전류만 빠르면 된다.
    expect(essResistanceGrowth.requires.metrics.filter((m) => m.maxPeriodS === FAST_S).map((m) => m.key)).toEqual(['batt.current', 'batt.voltage']);
    expect(elSecRise.requires.metrics.filter((m) => m.maxPeriodS === FAST_S).map((m) => m.key)).toEqual(['stack.current', 'stack.voltage']);
  });

  it('권장 메트릭은 판별 체크·보조 축에만 쓰는 것이고, 필수 메트릭과 겹치지 않는다', () => {
    const optional = new Map(DETECTORS.map((d) => [d.id, d.requires.metrics.filter((m) => m.optional === true).map((m) => m.key)]));
    expect(optional.get('fc.voltage_decay')).toEqual(['blower.power']);
    expect(optional.get('el.sec_rise')).toEqual(['rectifier.efficiency', 'purge.count']);
    expect(optional.get('tank.static_leak')).toEqual(['h2.pressure']);
    expect(optional.get('pv.soiling_rate')).toEqual(['ghi.irradiance']);
    expect(optional.get('ess.capacity_fade')).toEqual([]);
    for (const detector of DETECTORS) {
      const required = detector.requires.metrics.filter((m) => m.optional !== true).map((m) => m.key);
      expect(required.filter((key) => (optional.get(detector.id) ?? []).includes(key))).toEqual([]);
    }
  });
});
