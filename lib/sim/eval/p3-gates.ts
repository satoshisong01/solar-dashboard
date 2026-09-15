// P3 게이트와 부가 지표 (설계 §8 P3 완료 기준 + 탐지기별 기준 크기). 순수 모듈.
//   건강한 사이트 물질수지: 대조군 SIM-C 일별 |잔차율| 중앙값 < 1% · 95퍼센타일 < 2% (수소 원장 완결성 0.9 이상인 날)
//   저장용기 미세누설 최소 탐지 크기: 재현율 0.9 이상인 가장 작은 누설률이 스윕 안에 있음 (곡선은 detectors 항목)
//   PV 대조군: 출력제어·흐린 주·비 오는 주 구간(+7일)에 PV 탐지기 finding 0건
//   탐지기별 기준 크기 재현율 ≥ 0.8 (오탐 ≤ 0.1건/자산·월은 탐지기 공통 게이트)
import { r } from '@/lib/analytics/detectors/common';
import { quantile } from '@/lib/analytics/stats/robust';
import { DAYS_PER_MONTH, MS_PER_DAY } from '@/lib/analytics/types';
import { gate, type GateResult } from './gate';
import { DEFAULT_TOLERANCE_DAYS, scoreAtLeast, type DetectorScore } from './score';
import type { InjectionResult, SiteJobResult } from './types';

const CONTROL_SITE = 'SIM-C';
const HEALTHY_MIN_COMPLETENESS = 0.9;
const PV_DETECTORS: readonly string[] = ['pv.inverter_peer', 'pv.soiling_rate', 'inv.thermal_derating'];
const PV_CONTROLS: readonly string[] = ['control.curtailment', 'control.cloudy_week', 'control.rainy_week'];
const REFERENCE_RECALL = 0.8;

/** 대조군 사이트 일별 |잔차율| (완결성 기준 통과한 날) */
export function healthyResiduals(jobs: readonly SiteJobResult[]): number[] {
  return jobs
    .filter((j) => j.siteCode === CONTROL_SITE)
    .flatMap((j) => (j.ledgerResiduals ?? []).flatMap((d) => (d.residualPct !== null && (d.completeness ?? 0) >= HEALTHY_MIN_COMPLETENESS ? [Math.abs(d.residualPct)] : [])));
}

/** PV 대조군 구간(+허용 7일)에 나온 PV 탐지기 finding (점검 시각 기준, 같은 잡의 대조군) */
export function pvControlFindings(jobs: readonly SiteJobResult[]): number {
  return jobs.reduce((sum, job) => {
    const windows = job.controls.filter((c) => PV_CONTROLS.includes(c.kind));
    return sum + job.detections.filter((d) => PV_DETECTORS.includes(d.detectorId) && windows.some((w) => d.ts >= w.startTs && d.ts <= w.endTs + DEFAULT_TOLERANCE_DAYS * MS_PER_DAY)).length;
  }, 0);
}

const ofKind = (...kinds: string[]) => (i: InjectionResult): boolean => kinds.includes(i.injection.kind);

/** 블로워 마모(%/월)가 실행 끝까지 누적 기준 크기에 닿는지 */
const wearReaches = (pct: number) => (i: InjectionResult): boolean =>
  i.injection.kind === 'fault.fc_blower_wear' && (i.injection.endTs ?? i.injection.startTs) > i.injection.startTs && (Number(i.injection.params.pctPerMonth) * ((i.injection.endTs ?? i.injection.startTs) - i.injection.startTs)) / MS_PER_DAY / DAYS_PER_MONTH >= pct;

function referenceGates(jobs: readonly SiteJobResult[]): GateResult[] {
  const secRise = scoreAtLeast(jobs, 'el.sec_rise', 5);
  const valve = scoreAtLeast(jobs, 'comp.sec_rise', 10, { filter: ofKind('fault.compressor_valve_wear') });
  const blower = scoreAtLeast(jobs, 'fc.blower_wear', 0, { filter: (i) => (i.injection.kind === 'fault.fc_air_filter_clog' && i.magnitude >= 20) || wearReaches(20)(i) });
  const soiling = scoreAtLeast(jobs, 'pv.soiling_rate', 0.1);
  const resistance = scoreAtLeast(jobs, 'ess.resistance_growth', 40);
  const fan = scoreAtLeast(jobs, 'inv.thermal_derating', 0);
  const drift = scoreAtLeast(jobs, 'h2chain.mass_balance_gap', 3, { filter: ofKind('fault.flowmeter_drift') });
  return [
    gate('el.sec_rise.recall_5pct', `el.sec_rise 비에너지 5% 이상(정류기·패러데이·스택 경로) 재현율 (주입 ${secRise.injections}건)`, secRise.recall, '>=', REFERENCE_RECALL),
    gate('comp.sec_rise.recall_valve_10pct', `comp.sec_rise 밸브 마모 10% 이상 재현율 (주입 ${valve.injections}건)`, valve.recall, '>=', REFERENCE_RECALL),
    gate('fc.blower_wear.recall_20pct', `fc.blower_wear 블로워 비전력 +20% 이상(필터 막힘 20% 이상·마모 누적 20% 이상) 재현율 (주입 ${blower.injections}건)`, blower.recall, '>=', REFERENCE_RECALL),
    gate('pv.soiling_rate.recall_0_1pct_day', `pv.soiling_rate 오염 0.1%/일 이상 재현율 (주입 ${soiling.injections}건)`, soiling.recall, '>=', REFERENCE_RECALL),
    gate('ess.resistance_growth.recall_40pct', `ess.resistance_growth 내부저항 +40% 이상 재현율 (주입 ${resistance.injections}건)`, resistance.recall, '>=', REFERENCE_RECALL),
    gate('inv.thermal_derating.recall_fan_failure', `inv.thermal_derating 냉각팬 고장(겨울·봄·여름 시작, 여름 고온기 포함) 재현율 (주입 ${fan.injections}건)`, fan.recall, '>=', REFERENCE_RECALL),
    gate('h2chain.mass_balance_gap.recall_drift_3pct', `h2chain.mass_balance_gap 유량계 드리프트 3%/월 이상 재현율 (주입 ${drift.injections}건)`, drift.recall, '>=', REFERENCE_RECALL),
  ];
}

export function p3Gates(jobs: readonly SiteJobResult[], scores: readonly DetectorScore[]): GateResult[] {
  const residuals = healthyResiduals(jobs);
  const leak = scores.find((s) => s.detectorId === 'tank.static_leak');
  const largestLeak = Math.max(0, ...(leak?.curve.map((p) => p.magnitude) ?? []));
  return [
    gate('h2chain.healthy_residual_median', `대조군 SIM-C 일별 수소 물질수지 |잔차율| 중앙값 [%] (${residuals.length}일)`, residuals.length === 0 ? null : quantile(residuals, 0.5), '<', 1),
    gate('h2chain.healthy_residual_p95', 'SIM-C 일별 |잔차율| 95퍼센타일 [%]', residuals.length === 0 ? null : quantile(residuals, 0.95), '<', 2),
    gate('tank.static_leak.min_detectable_kg_per_day', `tank.static_leak 재현율 0.9 이상 최소 누설률 [kg/일] (스윕 최대 ${largestLeak} 이하여야 함)`, leak?.minDetectableMagnitude ?? null, '<=', largestLeak > 0 ? largestLeak : 0),
    gate('pv.control_findings', 'PV 대조군(출력제어·흐린 주·비 오는 주) 구간 PV 탐지기 finding 수', jobs.some((j) => j.controls.some((c) => PV_CONTROLS.includes(c.kind))) ? pvControlFindings(jobs) : null, '<=', 0),
    ...referenceGates(jobs),
  ];
}

const SEC_PATH_CHECK: Readonly<Record<string, string>> = { rectifier: 'rectifier_efficiency', faradaic: 'faraday_efficiency', stack: 'stack_voltage' };

/** el.sec_rise 탐지된 주입 중 마지막 탐지의 판별 체크가 주입 경로를 '지지'한 비율 (게이트 아님, 목표 ≥ 0.7) */
export function secPathSupport(jobs: readonly SiteJobResult[]) {
  const rows = jobs.flatMap((job) =>
    job.injections
      .filter((i) => i.detectorId === 'el.sec_rise' && i.firstDetectionTs !== null)
      .map((i) => {
        const mode = String(i.injection.params.mode);
        const last = job.detections.filter((d) => d.detectorId === 'el.sec_rise' && d.assetId === i.assetId && d.ts >= i.injection.startTs && d.ts <= (i.injection.endTs ?? i.injection.startTs) + DEFAULT_TOLERANCE_DAYS * MS_PER_DAY).at(-1);
        return { mode, hit: last?.supportedChecks?.includes(SEC_PATH_CHECK[mode] ?? '') ?? false };
      }),
  );
  const ratio = (items: readonly { hit: boolean }[]) => (items.length === 0 ? null : r(items.filter((x) => x.hit).length / items.length, 3));
  return { overall: ratio(rows), detected: rows.length, by_mode: Object.fromEntries(Object.keys(SEC_PATH_CHECK).map((mode) => [mode, { detected: rows.filter((x) => x.mode === mode).length, support_ratio: ratio(rows.filter((x) => x.mode === mode)) }])), target: 0.7 };
}

/** 누설 0.2 kg/일 이상 주입에서 같은 사이트 물질수지 finding이 주입 기간에 나온 비율 (부수 탐지, 참고) */
export function leakMassBalanceShare(jobs: readonly SiteJobResult[]) {
  const rows = jobs.flatMap((job) =>
    job.injections
      .filter((i) => i.detectorId === 'tank.static_leak' && i.magnitude >= 0.2)
      .map((i) => job.detections.some((d) => d.detectorId === 'h2chain.mass_balance_gap' && d.ts >= i.injection.startTs && d.ts <= (i.injection.endTs ?? i.injection.startTs) + DEFAULT_TOLERANCE_DAYS * MS_PER_DAY)),
  );
  return { injections: rows.length, with_mass_balance_finding: rows.filter(Boolean).length, share: rows.length === 0 ? null : r(rows.filter(Boolean).length / rows.length, 3) };
}

/** 냉각팬 고장 시작일별 탐지 지연 */
export function fanDelays(jobs: readonly SiteJobResult[]) {
  const rows = jobs.flatMap((job) => job.injections.filter((i) => i.detectorId === 'inv.thermal_derating').map((i) => ({ start: Math.round((i.injection.startTs - job.fromMs) / MS_PER_DAY), delay: i.firstDetectionTs === null ? null : r((i.firstDetectionTs - i.injection.startTs) / MS_PER_DAY, 1) })));
  return [...new Set(rows.map((x) => x.start))].sort((a, b) => a - b).map((start) => ({ start_day: start, delays_days: rows.filter((x) => x.start === start).map((x) => x.delay) }));
}

export function healthyResidualStats(jobs: readonly SiteJobResult[]) {
  const residuals = healthyResiduals(jobs);
  return residuals.length === 0 ? null : { days: residuals.length, median_pct: r(quantile(residuals, 0.5), 3), p90_pct: r(quantile(residuals, 0.9), 3), p95_pct: r(quantile(residuals, 0.95), 3), max_pct: r(Math.max(...residuals), 3) };
}
