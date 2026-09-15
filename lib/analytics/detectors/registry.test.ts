// 탐지기 레지스트리 계약: paramSchema(설정 UI) · requires(탐지 준비도 매트릭스) · id·고장모드 형식.
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { DETECTORS, P2_DETECTORS, P3_DETECTORS } from './index';

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
      expect(d.version).toBe('1');
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

  it('requires: 설비 종류·메트릭은 카탈로그에 있고, 샘플 주기 상한·최소 데이터 기간이 채워져 있다', () => {
    for (const detector of DETECTORS) {
      const { assetClass, metrics, minPeriodS, minHistoryDays } = detector.requires;
      assetClass.forEach((key) => expect(ASSET_CLASS_BY_KEY.has(key), `${detector.id} ${key}`).toBe(true));
      metrics.forEach((key) => expect(METRIC_DEF_BY_KEY.has(key), `${detector.id} ${key}`).toBe(true));
      expect(minPeriodS === null || minPeriodS > 0).toBe(true);
      expect(minHistoryDays).toBeGreaterThanOrEqual(1);
      if (detector.id !== 'dq.gap_flatline') {
        expect(assetClass.length).toBeGreaterThan(0);
        expect(metrics.length).toBeGreaterThan(0);
      }
    }
  });
});
