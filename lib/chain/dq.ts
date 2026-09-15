// 체인 원장 데이터 품질 경고 (순수). 원장 값을 해석하기 전에 볼 것: 원천 완결성 부족일·계측 불일치율.
//   완결성   에너지 원천(설비 종류/메트릭별)·수소·PV 중 하나라도 LEDGER_MIN_COMPLETENESS 미만인 날
//   불일치율 기간 합 unmetered kWh ÷ 풀 kWh(공급 합 + 미계측 공급)과, 일별 불일치율이 기준을 넘은 날
import type { SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { LEDGER_MAX_UNMETERED_RATIO, LEDGER_MIN_COMPLETENESS } from './limits';

export interface LedgerDqWarning {
  readonly code: 'energy_completeness' | 'h2_completeness' | 'pv_completeness' | 'unmetered_period' | 'unmetered_days';
  readonly message: string;
  /** 해당 날짜 (최대 5개, 나머지는 message의 건수로) */
  readonly sampleDays: readonly string[];
}

export interface LedgerDqSummary {
  readonly periodUnmeteredRatio: number | null;
  readonly warnings: readonly LedgerDqWarning[];
}

const SAMPLE_DAYS = 5;
const pct = (value: number, digits = 1): string => `${(Math.round(value * 100 * 10 ** digits) / 10 ** digits).toString()}%`;
const low = (value: number | null): boolean => value !== null && value < LEDGER_MIN_COMPLETENESS;

function dayWarning(code: LedgerDqWarning['code'], days: readonly SiteEnergyDay[], describe: (count: number) => string): LedgerDqWarning[] {
  return days.length === 0 ? [] : [{ code, message: describe(days.length), sampleDays: days.slice(0, SAMPLE_DAYS).map((d) => d.day) }];
}

export function ledgerDqSummary(days: readonly SiteEnergyDay[]): LedgerDqSummary {
  const pool = days.reduce((sum, d) => sum + d.energy_kwh.pv + d.energy_kwh.ess_discharge + d.energy_kwh.fc + d.energy_kwh.grid_import + d.energy_kwh.unmetered_supply, 0);
  const unmetered = days.reduce((sum, d) => sum + d.dq.energy.unmetered_kwh, 0);
  const periodUnmeteredRatio = pool > 0 ? unmetered / pool : null;
  const threshold = pct(LEDGER_MAX_UNMETERED_RATIO, 0);
  const minPct = pct(LEDGER_MIN_COMPLETENESS, 0);

  const energyLow = days.filter((d) => Object.values(d.dq.energy.completeness).some(low));
  const lowSources = [...new Set(energyLow.flatMap((d) => Object.entries(d.dq.energy.completeness).filter(([, v]) => low(v)).map(([key]) => key)))];
  const warnings: LedgerDqWarning[] = [
    ...dayWarning('energy_completeness', energyLow, (n) => `전력 원천 완결성 ${minPct} 미만인 날 ${n}일 (${lowSources.join(', ')}) — 그날 흐름·보조부하 잔여가 작게 잡힙니다`),
    ...dayWarning('h2_completeness', days.filter((d) => low(d.dq.h2.completeness)), (n) => `수소 원장 완결성 ${minPct} 미만인 날 ${n}일 — 물질수지 탐지에서 빠지고 잔차가 흔들립니다`),
    ...dayWarning('pv_completeness', days.filter((d) => low(d.dq.pv.completeness)), (n) => `인버터 출력 완결성 ${minPct} 미만인 날 ${n}일 — PV 미활용 분해에서 데이터 없는 시간은 기대·실제에서 함께 뺐습니다`),
    ...(periodUnmeteredRatio !== null && periodUnmeteredRatio > LEDGER_MAX_UNMETERED_RATIO
      ? [{ code: 'unmetered_period' as const, message: `기간 계측 불일치율 ${pct(periodUnmeteredRatio, 2)} (기준 ${threshold} 이하) — 계량점 누락·스케일 오류를 확인하세요`, sampleDays: [] }]
      : []),
    ...dayWarning('unmetered_days', days.filter((d) => (d.dq.energy.unmetered_ratio ?? 0) > LEDGER_MAX_UNMETERED_RATIO), (n) => `일 계측 불일치율이 ${threshold}를 넘은 날 ${n}일`),
  ];
  return { periodUnmeteredRatio, warnings };
}
