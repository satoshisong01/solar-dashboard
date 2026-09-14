import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { EVENT_CODE } from './events';
import { MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { createPlant, SAFETY_LOCKOUT_MS, type PlantStep } from './plant';
import { planScenarios, type Scenario } from './scenarios';

const DAY_START = Date.parse('2026-06-10T00:00:00+09:00');

function site(code: string): SiteDef {
  const found = SIM_SITES.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found;
}

function runPlant(code: string, minutes: number, options: { seed?: number; scenarios?: readonly Scenario[]; start?: number } = {}): PlantStep[] {
  const target = site(code);
  const start = options.start ?? DAY_START;
  const plan = planScenarios([target], options.scenarios ?? []).get(code);
  const plant = createPlant({ site: target, seed: options.seed ?? 1, startMs: start, stepS: 60, plan });
  return Array.from({ length: minutes }, (_, i) => plant.step(start + (i + 1) * MS_PER_MINUTE));
}

const valuesOf = (steps: readonly PlantStep[], sourceKey: string) =>
  steps.flatMap((s) => s.samples.filter((x) => x.sourceKey === sourceKey).map((x) => ({ ts: x.ts, value: x.value })));

describe('createPlant — 하루 실행', () => {
  const days = new Map(SIM_SITES.map((s) => [s.code, runPlant(s.code, 1_440)]));

  it.each(SIM_SITES.map((s) => s.code))('%s: 모든 매핑·미매핑 포인트가 period_s마다 유한한 값을 낸다', (code) => {
    const steps = days.get(code) ?? [];
    const target = site(code);
    const expected = [
      ...target.assets.flatMap((a) => a.points.map((p) => [p.sourceKey, p.periodS, true] as const)),
      ...target.unmappedTags.map((t) => [t.sourceKey, t.periodS, false] as const),
    ];
    const counts = new Map<string, number>();
    const mappedFlags = new Map<string, boolean>();
    for (const sample of steps.flatMap((s) => s.samples)) {
      expect(Number.isFinite(sample.value), sample.sourceKey).toBe(true);
      counts.set(sample.sourceKey, (counts.get(sample.sourceKey) ?? 0) + 1);
      mappedFlags.set(sample.sourceKey, sample.mapped);
    }

    expect(counts.size).toBe(expected.length);
    for (const [sourceKey, periodS, mapped] of expected) {
      expect(counts.get(sourceKey), sourceKey).toBe(86_400 / periodS);
      expect(mappedFlags.get(sourceKey), sourceKey).toBe(mapped);
    }
  });

  it('밤(01~04시 KST)에는 모든 인버터 출력이 0이고, 한낮에는 발전한다', () => {
    const steps = days.get('SIM-B') ?? [];
    const inverterKeys = site('SIM-B').assets.filter((a) => a.classKey === 'pv.inverter').map((a) => `${a.code}/P_AC`);
    const night = steps.filter((s) => s.tMs > DAY_START + 1 * MS_PER_HOUR && s.tMs <= DAY_START + 4 * MS_PER_HOUR);
    const noon = steps.filter((s) => s.tMs > DAY_START + 11 * MS_PER_HOUR && s.tMs <= DAY_START + 13 * MS_PER_HOUR);

    for (const key of inverterKeys) {
      expect(valuesOf(night, key).every((x) => x.value === 0), key).toBe(true);
      expect(Math.max(...valuesOf(noon, key).map((x) => x.value)), key).toBeGreaterThan(50);
    }
  });

  it.each(['SIM-A', 'SIM-B', 'SIM-C'])('%s: ESS SOC는 하루 내내 0~100% 안이고 충방전이 일어난다', (code) => {
    const steps = days.get(code) ?? [];
    const socKeys = site(code).assets.filter((a) => a.classKey === 'ess.rack').map((a) => `${a.code}/SOC`);
    for (const key of socKeys) {
      const socs = valuesOf(steps, key).map((x) => x.value);
      expect(Math.min(...socs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...socs)).toBeLessThanOrEqual(100);
      expect(Math.max(...socs) - Math.min(...socs)).toBeGreaterThan(20);
    }
  });

  it('랙 셀 전압 통계는 노이즈가 섞여도 최고 ≥ 평균 ≥ 최저 순서를 지킨다', () => {
    const steps = days.get('SIM-A') ?? [];
    for (const rack of ['ESS1/RACK01', 'ESS1/RACK04']) {
      const max = valuesOf(steps, `${rack}/V_CELL_MAX`);
      const avg = valuesOf(steps, `${rack}/V_CELL_AVG`);
      const min = valuesOf(steps, `${rack}/V_CELL_MIN`);
      max.forEach((m, i) => {
        expect(m.value, `${rack} ${m.ts}`).toBeGreaterThanOrEqual(avg[i]?.value ?? Infinity);
        expect(avg[i]?.value ?? -Infinity).toBeGreaterThanOrEqual(min[i]?.value ?? Infinity);
      });
    }
  });

  it('원본 단위로 보낸다: MPa·K·mV·MΩ 태그는 정규값을 역변환한 값이다', () => {
    const steps = days.get('SIM-B') ?? [];
    const last = steps.at(-1);
    if (!last) throw new Error('스텝 없음');
    const raw = (key: string) => last.samples.find((s) => s.sourceKey === key)?.value ?? Number.NaN;
    const truth = (asset: string, metric: string) => last.readings.get(asset)?.[metric] ?? Number.NaN;

    expect(raw('H2BANK1/TANK1/P')).toBeCloseTo(truth('H2BANK1/TANK1', 'tank.pressure') / 10, 0);
    expect(raw('FC1/COOL1/T_IN') - 273.15).toBeCloseTo(truth('FC1/COOL1', 'fc.coolant.temp.in'), 0);
    expect(raw('ESS1/RACK01/V_CELL_AVG') / 1000).toBeCloseTo(truth('ESS1/RACK01', 'cell.voltage.avg'), 2);
    expect(raw('PV1/INV01/R_ISO') * 1000).toBeCloseTo(truth('PV1/INV01', 'insulation.resistance'), -3);
  });

  it('연계형 사이트는 낮에 전해조·압축기를, 저녁에 연료전지를 돌리고 기동·정지 이벤트를 남긴다', () => {
    const events = (days.get('SIM-B') ?? []).flatMap((s) => s.events);
    const has = (src: string, code: string) => events.some((e) => e.src === src && e.code === code);

    expect(has('ELZ1/EVENT', EVENT_CODE.START)).toBe(true);
    expect(has('COMP1/EVENT', EVENT_CODE.START)).toBe(true);
    expect(has('FC1/EVENT', EVENT_CODE.START)).toBe(true);
    expect(has('FC1/EVENT', EVENT_CODE.STOP)).toBe(true);
  });
});

describe('createPlant — 결정성과 호출 규칙', () => {
  it('같은 시드는 같은 샘플, 다른 시드는 다른 샘플', () => {
    const a = runPlant('SIM-C', 180, { seed: 5 });
    const b = runPlant('SIM-C', 180, { seed: 5 });
    const c = runPlant('SIM-C', 180, { seed: 6 });
    const strip = (steps: PlantStep[]) => steps.map((s) => [s.samples, s.events]);

    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).not.toEqual(strip(a));
  });

  it('스텝 시각을 건너뛰면 오류', () => {
    const plant = createPlant({ site: site('SIM-A'), seed: 1, startMs: DAY_START, stepS: 60 });

    expect(() => plant.step(DAY_START + 2 * MS_PER_MINUTE)).toThrow('스텝 순서');
  });
});

describe('createPlant — 시나리오 반영', () => {
  it('dq.stuck_sensor: 구간 동안 같은 값을 보내고 구간이 끝나면 다시 변한다', () => {
    const start = DAY_START + 10 * MS_PER_HOUR;
    const steps = runPlant('SIM-A', 720, { scenarios: [{ kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'ESS1/RACK01/T_CELL_AVG', start, durationS: 3_600 }] });
    const values = valuesOf(steps, 'ESS1/RACK01/T_CELL_AVG');
    const inside = values.filter((x) => x.ts >= start && x.ts < start + MS_PER_HOUR).map((x) => x.value);
    const after = values.filter((x) => x.ts >= start + MS_PER_HOUR).map((x) => x.value);

    expect(inside).toHaveLength(60);
    expect(new Set(inside).size).toBe(1);
    expect(new Set(after).size).toBeGreaterThan(5);
  });

  it('dq.spike: 지정 태그에 기대범위를 크게 벗어나는 값이 섞이고 다른 태그는 그대로다', () => {
    const scenarios: Scenario[] = [{ kind: 'dq.spike', site: 'SIM-A', sourceKey: 'WX1/T_AMB', perDay: 30, magnitude: 5 }];
    const spiked = valuesOf(runPlant('SIM-A', 1_440, { scenarios }), 'WX1/T_AMB').map((x) => x.value);
    const clean = valuesOf(runPlant('SIM-A', 1_440), 'WX1/T_AMB').map((x) => x.value);
    const otherSpiked = valuesOf(runPlant('SIM-A', 600, { scenarios }), 'WX1/RH');
    const otherClean = valuesOf(runPlant('SIM-A', 600), 'WX1/RH');

    expect(spiked.filter((v, i) => Math.abs(v - (clean[i] ?? v)) > 30).length).toBeGreaterThan(3);
    expect(otherSpiked).toEqual(otherClean);
  });

  it('safety.h2_leak_alarm: 경보 이벤트·검지 농도 상승·수소 설비 인터록 정지', () => {
    const at = DAY_START + 13 * MS_PER_HOUR + 30_000;
    const steps = runPlant('SIM-B', 17 * 60, { scenarios: [{ kind: 'safety.h2_leak_alarm', site: 'SIM-B', at }] });
    const alarms = steps.flatMap((s) => s.events).filter((e) => e.code === EVENT_CODE.H2_LEAK_L1);
    const ppmAtAlarm = valuesOf(steps, 'GD3/H2_PPM').find((x) => x.ts >= at && x.ts < at + 5 * MS_PER_MINUTE);
    const lockoutStacks = steps.filter((s) => s.tMs > at + 10 * MS_PER_MINUTE && s.tMs < at + SAFETY_LOCKOUT_MS);

    expect(alarms).toEqual([{ src: 'GD3/ALARM', ts: DAY_START + 13 * MS_PER_HOUR + MS_PER_MINUTE, code: 'H2_LEAK_L1', severity: 'critical', text: expect.any(String) }]);
    expect(ppmAtAlarm?.value).toBeGreaterThanOrEqual(4_000);
    expect(lockoutStacks.every((s) => s.readings.get('ELZ1/STACK1')?.['stack.current'] === 0)).toBe(true);
    expect(valuesOf(steps, 'GD1/H2_PPM').every((x) => x.value < 100)).toBe(true);
  });

  it('fault hook: 인버터 효율 저하·용량 감소가 해당 설비 값에만 반영된다', () => {
    const steps = runPlant('SIM-B', 1_440, {
      scenarios: [
        { kind: 'fault', site: 'SIM-B', param: 'inverter.efficiencyDrop', asset: 'PV1/INV01', value: () => 0.05 },
        { kind: 'fault', site: 'SIM-B', param: 'battery.capacityFadePerDay', asset: 'ESS1/RACK02', value: () => 0.01 },
      ],
    });
    const energy = (asset: string) => steps.reduce((sum, s) => sum + (s.readings.get(asset)?.['ac.power'] ?? 0) / 60, 0);
    const soh = (asset: string) => steps.at(-1)?.readings.get(asset)?.['batt.soh'] ?? Number.NaN;

    expect(energy('PV1/INV01') / energy('PV1/INV02')).toBeLessThan(0.97);
    expect(energy('PV1/INV03') / energy('PV1/INV02')).toBeGreaterThan(0.99);
    expect(soh('ESS1/RACK01') - soh('ESS1/RACK02')).toBeCloseTo(1 - 0.005, 1);
  });
});
