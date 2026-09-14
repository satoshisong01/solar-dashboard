// 음성 대조군 조건이 플랜트 출력에 나타나는지, 같은 시드의 조건 없는 실행과 비교해 확인한다.
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { EVENT_CODE } from './events';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { createPlant, type PlantStep } from './plant';
import { planScenarios, scenarioOriginMs, type Scenario } from './scenarios';

const FROM = Date.parse('2026-04-01T00:00:00+09:00');
const DAYS = 15;
const day = (n: number, hour = 0) => FROM + n * MS_PER_DAY + hour * MS_PER_HOUR;

interface StepView {
  readonly tMs: number;
  readonly value: (asset: string, metric: string) => number;
  readonly events: PlantStep['events'];
}

/** 필요한 참값만 남겨 메모리를 아낀다 */
function runSite(code: string, scenarios: readonly Scenario[], keep: readonly (readonly [asset: string, metric: string])[]): StepView[] {
  const site = SIM_SITES.find((s) => s.code === code);
  if (!site) throw new Error(code);
  const plan = planScenarios([site], scenarios, { originMs: scenarioOriginMs(FROM) }).get(code);
  const plant = createPlant({ site, seed: 21, startMs: FROM, stepS: 60, plan });
  const views: StepView[] = [];
  for (let t = FROM + MS_PER_MINUTE; t <= day(DAYS); t += MS_PER_MINUTE) {
    const step = plant.step(t);
    const kept = new Map(keep.map(([asset, metric]) => [`${asset}|${metric}`, step.readings.get(asset)?.[metric] ?? Number.NaN]));
    views.push({ tMs: t, value: (asset, metric) => kept.get(`${asset}|${metric}`) ?? Number.NaN, events: step.events });
  }
  return views;
}

const at = (views: readonly StepView[], tMs: number): StepView => {
  const view = views.find((v) => v.tMs === tMs);
  if (!view) throw new Error(`스텝 없음: ${new Date(tMs).toISOString()}`);
  return view;
};
const between = (views: readonly StepView[], fromMs: number, toMs: number) => views.filter((v) => v.tMs >= fromMs && v.tMs < toMs);
const INVERTERS = ['PV1/INV01', 'PV1/INV02', 'PV1/INV03', 'PV1/INV04'];

describe('대조군 — SIM-C 한파 주간·흐린 주·출력제어', () => {
  const keep = [['WX1', 'ambient.temp'], ['WX1', 'poa.irradiance'], ['ESS1', 'room.temp'], ...INVERTERS.flatMap((inv) => [[inv, 'ac.power'], [inv, 'ac.power.limit']] as const)] as const;
  let base: StepView[] = [];
  let control: StepView[] = [];

  beforeAll(() => {
    base = runSite('SIM-C', [], keep);
    control = runSite('SIM-C', [
      { kind: 'control.cold_week', site: 'SIM-C', startDay: 1 },
      { kind: 'control.cloudy_week', site: 'SIM-C', startDay: 8 },
      { kind: 'control.curtailment', site: 'SIM-C', startDay: 2, count: 2 },
    ], keep);
  }, 120_000);

  it('control.cold_week: 외기 −10 °C(양끝 12시간 램프), 배터리실 −4.8 °C(외기 영향 + 난방 부족)', () => {
    const diff = (t: number, asset: string, metric: string) => at(control, t).value(asset, metric) - at(base, t).value(asset, metric);

    expect(diff(day(0, 12), 'WX1', 'ambient.temp')).toBe(0);
    expect(diff(day(1, 6), 'WX1', 'ambient.temp')).toBeCloseTo(-5, 6);
    expect(diff(day(4, 12), 'WX1', 'ambient.temp')).toBeCloseTo(-10, 6);
    expect(diff(day(4, 12), 'ESS1', 'room.temp')).toBeCloseTo(-4.8, 6);
    expect(diff(day(8, 12), 'ESS1', 'room.temp')).toBe(0);
  });

  it('control.cloudy_week: 그 주 일사량이 조건 없는 실행의 75% 미만', () => {
    const poa = (views: readonly StepView[]) => between(views, day(8), day(15)).reduce((sum, v) => sum + v.value('WX1', 'poa.irradiance'), 0);

    expect(poa(control) / poa(base)).toBeLessThan(0.75);
  });

  it('control.curtailment: 11~15시 전 인버터 출력 제한 0%·출력 0, 조건 없는 실행은 그 시간에 발전한다', () => {
    for (const d of [2, 9]) {
      const window = between(control, day(d, 11), day(d, 15));
      expect(window).toHaveLength(240);
      for (const inv of INVERTERS) {
        expect(window.every((v) => v.value(inv, 'ac.power.limit') === 0 && v.value(inv, 'ac.power') === 0), `${d}일 ${inv}`).toBe(true);
        expect(between(base, day(d, 11), day(d, 15)).reduce((sum, v) => sum + v.value(inv, 'ac.power'), 0)).toBeGreaterThan(0);
      }
      expect(at(control, day(d, 15)).value('PV1/INV01', 'ac.power.limit')).toBe(100);
    }
  });
});

describe('대조군 — SIM-B 전해조 부분부하·연료전지 잦은 기동정지·SOC 상한 변경', () => {
  const keep = [['ELZ1', 'ac.power'], ['ESS1/RACK01', 'batt.soc'], ['ESS1/RACK02', 'batt.soc']] as const;
  let base: StepView[] = [];
  let control: StepView[] = [];

  beforeAll(() => {
    base = runSite('SIM-B', [], keep);
    control = runSite('SIM-B', [
      { kind: 'control.elz_part_load_week', site: 'SIM-B', startDay: 1 },
      { kind: 'control.fc_frequent_start_stop', site: 'SIM-B', startDay: 8 },
      { kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 4, newLimit: 0.8 },
    ], keep);
  }, 120_000);

  it('control.elz_part_load_week: 그 주 전해조 전력은 정격 500 kW의 40% 이하, 조건 없는 실행은 그보다 크게 돌린다', () => {
    const maxKw = (views: readonly StepView[]) => Math.max(...between(views, day(1), day(8)).map((v) => v.value('ELZ1', 'ac.power')));

    expect(maxKw(control)).toBeLessThanOrEqual(200.5);
    expect(maxKw(base)).toBeGreaterThan(300);
  });

  it('control.fc_frequent_start_stop: 그 주 연료전지 기동 횟수가 하루 1회 운전보다 훨씬 많다', () => {
    const starts = (views: readonly StepView[]) => between(views, day(8), day(15)).flatMap((v) => v.events).filter((e) => e.src === 'FC1/EVENT' && e.code === EVENT_CODE.START).length;

    expect(starts(base)).toBeLessThanOrEqual(7);
    expect(starts(control)).toBeGreaterThanOrEqual(35);
  });

  it('control.soc_upper_limit_change: 변경 뒤 랙 SOC가 80% 위로 충전되지 않는다 (조건 없는 실행은 90% 가까이)', () => {
    const maxSoc = (views: readonly StepView[]) => Math.max(...between(views, day(4, 1), day(DAYS)).flatMap((v) => [v.value('ESS1/RACK01', 'batt.soc'), v.value('ESS1/RACK02', 'batt.soc')]));

    expect(maxSoc(control)).toBeLessThan(81);
    expect(maxSoc(base)).toBeGreaterThan(88);
  });
});
