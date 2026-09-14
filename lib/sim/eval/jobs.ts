// 평가 실행 계획(evalRunPlans) → 사이트 잡. 사이트마다 난수 스트림·플랜트가 독립이므로
// 같은 시드·같은 시나리오인 사이트는 한 번만 시뮬레이션한다 (대조군 SIM-C는 시드당 1회).
import { stableStringify } from '@/lib/analytics/hash';
import type { EvalRunPlan } from '../presets';
import type { Scenario } from '../scenarios';

export interface SiteJob {
  readonly id: string;
  readonly seed: number;
  readonly siteCode: string;
  readonly from: string;
  readonly days: number;
  readonly scenarios: readonly Scenario[];
  /** 이 잡을 공유하는 실행 계획 id */
  readonly runIds: readonly string[];
}

export interface PlanSelection {
  /** 이 시드만 */
  readonly seeds?: readonly number[];
  /** 시드 안 스윕 순번 (1부터). 생략하면 전부 */
  readonly runs?: readonly number[];
}

export function selectPlans(plans: readonly EvalRunPlan[], selection: PlanSelection): EvalRunPlan[] {
  const { seeds, runs } = selection;
  const bySeed = plans.filter((plan) => seeds === undefined || seeds.includes(plan.seed));
  if (runs === undefined) return bySeed;
  return bySeed.filter((plan) => runs.includes(bySeed.filter((p) => p.seed === plan.seed).indexOf(plan) + 1));
}

const siteOf = (scenario: Scenario): string | null => ('site' in scenario ? scenario.site : null);

export function siteJobs(plans: readonly EvalRunPlan[]): SiteJob[] {
  const jobs = new Map<string, SiteJob>();
  for (const plan of plans) {
    for (const siteCode of plan.siteCodes) {
      const scenarios = plan.scenarios.filter((s) => siteOf(s) === siteCode);
      const key = `${plan.seed}|${siteCode}|${plan.from}|${plan.days}|${stableStringify(scenarios)}`;
      const existing = jobs.get(key);
      if (existing) {
        jobs.set(key, { ...existing, runIds: [...existing.runIds, plan.id] });
        continue;
      }
      const ordinal = [...jobs.values()].filter((j) => j.seed === plan.seed && j.siteCode === siteCode).length + 1;
      jobs.set(key, { id: `s${plan.seed}-${siteCode}-${ordinal}`, seed: plan.seed, siteCode, from: plan.from, days: plan.days, scenarios, runIds: [plan.id] });
    }
  }
  return [...jobs.values()];
}
