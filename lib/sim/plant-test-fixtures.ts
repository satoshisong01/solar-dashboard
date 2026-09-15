// 테스트 공용: 가상 사이트 플랜트를 시나리오와 함께 분 단위로 돌리고 필요한 참값만 남긴다.
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { MS_PER_DAY, MS_PER_MINUTE } from './math';
import { createPlant } from './plant';
import { planScenarios, scenarioOriginMs, type Scenario } from './scenarios';

export type Keep = readonly (readonly [asset: string, metric: string])[];

export interface View {
  readonly tMs: number;
  readonly value: (asset: string, metric: string) => number;
}

export function simSite(code: string): SiteDef {
  const found = SIM_SITES.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found;
}

/** from부터 days일 실행한다 (실행 기준일 = from이 속한 KST 날짜 0시) */
export function runSite(code: string, from: number, days: number, scenarios: readonly Scenario[], keep: Keep, seed = 31): View[] {
  const target = simSite(code);
  const plan = planScenarios([target], scenarios, { originMs: scenarioOriginMs(from) }).get(code);
  const plant = createPlant({ site: target, seed, startMs: from, stepS: 60, plan });
  const views: View[] = [];
  for (let t = from + MS_PER_MINUTE; t <= from + days * MS_PER_DAY; t += MS_PER_MINUTE) {
    const step = plant.step(t);
    const kept = new Map(keep.map(([asset, metric]) => [`${asset}|${metric}`, step.readings.get(asset)?.[metric] ?? Number.NaN]));
    views.push({ tMs: t, value: (asset, metric) => kept.get(`${asset}|${metric}`) ?? Number.NaN });
  }
  return views;
}

export const between = (views: readonly View[], fromMs: number, toMs: number): View[] => views.filter((v) => v.tMs >= fromMs && v.tMs < toMs);
export const sumOf = (views: readonly View[], asset: string, metric: string): number => views.reduce((sum, v) => sum + v.value(asset, metric), 0);
