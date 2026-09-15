// tank.static_leak 판별 체크 4종과 근거 스냅샷 (순수).
import { downsample } from '../episodes/series';
import type { BootstrapResult } from '../stats/bootstrap';
import { median } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { MS_PER_DAY, type JsonObject } from '../types';
import { levelCheck, makeCheck, pearson, SAFETY_DISCLAIMER } from './check-helpers';
import { r } from './common';
import type { H2Eos } from './hydrogen-eos';
import type { PressureCrossCheck, TankHoldInput, TankStaticLeakParams } from './tank-static-leak';
import type { CheckStatus, DiagnosticCheck } from './types';

/** 정지 보유 구간 하나의 온도 보정 질량 기울기 */
export interface HoldFit {
  readonly hold: TankHoldInput;
  readonly hours: number;
  /** 손실률 [kg/일] (양수 = 질량 감소) */
  readonly lossKgPerDay: number;
  readonly ciLowKgPerDay: number;
  readonly ciHighKgPerDay: number;
  /** 구간 안 온도 변화율 [°C/일] */
  readonly tempRateCPerDay: number;
  readonly tempMeanC: number;
  readonly pressureMeanBar: number;
  readonly massMeanKg: number;
}

export interface TankCheckInput {
  readonly fits: readonly HoldFit[];
  readonly recent: readonly HoldFit[];
  readonly leak: number;
  readonly volumeM3: number;
  readonly eos: H2Eos;
  readonly crossChecks?: readonly PressureCrossCheck[];
  readonly p: TankStaticLeakParams;
}

function temperatureCheck({ fits, p }: TankCheckInput): DiagnosticCheck {
  const rho = fits.length >= 5 ? pearson(fits.map((f) => f.tempRateCPerDay), fits.map((f) => f.lossKgPerDay)) : null;
  return levelCheck('temperature_compensation', '온도 보정 잔차 (손실률과 온도 변화율 상관)', rho === null ? null : Math.abs(rho), [p.tempCorrelationR, 0.3], { n: fits.length, pearson_r: r(rho, 3) }, {
    supports: '구간 손실률이 온도 변화율과 함께 움직입니다. 가스 온도와 센서 온도의 열 지연·센서 위치 때문에 보정이 부족할 수 있습니다. 냉각이 없는 구간만 따로 확인하세요.',
    refutes: '구간 손실률은 온도 변화와 관계가 약합니다. 온도 보정 부족으로 설명하기 어렵습니다.',
    unknown: '손실률과 온도 변화율 사이에 약한 상관이 있습니다.',
    no_data: '상관을 계산할 구간이 부족합니다 (5개 이상 필요).',
  });
}

function driftCheck({ crossChecks, recent, leak, volumeM3, eos }: TankCheckInput): DiagnosticCheck {
  const label = '압력 센서 드리프트 (같은 뱅크 용기·압축기 토출 압력 비교)';
  const points = [...(crossChecks ?? [])].sort((a, b) => a.ts - b.ts);
  const spanDays = points.length < 2 ? 0 : ((points.at(-1)?.ts ?? 0) - (points[0]?.ts ?? 0)) / MS_PER_DAY;
  if (points.length < 3 || spanDays < 1) return makeCheck('pressure_drift', label, 'no_data', { n: points.length }, '비교할 다른 압력 계측값이 부족합니다 (3회 이상, 1일 이상 필요).');
  const t0 = points[0]?.ts ?? 0;
  const fit = theilSen(points.map((pt) => (pt.ts - t0) / MS_PER_DAY), points.map((pt) => pt.offsetBar));
  const perBar = eos.densityPerBar(median(recent.map((f) => f.pressureMeanBar)), median(recent.map((f) => f.tempMeanC))) * volumeM3;
  const apparentLoss = -fit.slope * perBar;
  const share = leak > 0 ? apparentLoss / leak : null;
  return levelCheck('pressure_drift', label, share, [0.5, 0.2], { n: points.length, offset_slope_bar_per_day: r(fit.slope, 5), apparent_loss_kg_per_day: r(apparentLoss, 4), share_of_leak: r(share, 3), sources: [...new Set(points.map((pt) => pt.source))] }, {
    supports: '이 용기 압력만 비교 대상보다 점점 낮게 읽힙니다. 누설 대신 압력 전송기 드리프트일 수 있으니 교정 후 다시 확인하세요 (용기가 서로 연결돼 균압될 때만 유효한 비교입니다).',
    refutes: '비교 압력과의 차이는 그대로입니다. 압력 센서 드리프트로 설명하기 어렵습니다.',
    unknown: '비교 압력과의 차이가 조금 변했습니다.',
    no_data: '비교할 압력 계측값이 없습니다.',
  });
}

function valveCheck({ recent, p }: TankCheckInput): DiagnosticCheck {
  const known = recent.filter((f) => f.hold.downstreamRiseBar !== null);
  const rising = known.filter((f) => (f.hold.downstreamRiseBar ?? 0) >= p.downstreamRiseBar).length;
  const share = known.length === 0 ? null : rising / known.length;
  const status: CheckStatus = share === null ? 'no_data' : share >= 0.5 ? 'supports' : rising === 0 ? 'refutes' : 'unknown';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '정지 구간 동안 하류 압력이 함께 올랐습니다. 외부 누설이 아니라 닫힌 밸브를 지나는 내부 통과 누설일 수 있습니다. 출구 차단밸브 시트를 점검하세요.',
    refutes: '하류 압력 상승은 없었습니다. 밸브 통과 누설 가능성은 낮습니다.',
    unknown: '일부 구간에서만 하류 압력이 올랐습니다.',
    no_data: '하류 압력 데이터가 없습니다.',
  };
  return makeCheck('valve_passing', '밸브 통과 누설 (하류 압력 상승 동반)', status, { holds_with_data: known.length, holds_with_rise: rising }, notes[status]);
}

function sufficiencyCheck({ recent, p }: TankCheckInput): DiagnosticCheck {
  const hours = median(recent.map((f) => f.hours));
  const status: CheckStatus = recent.length < p.recentHolds || hours < 1.5 * p.minStaticHours ? 'supports' : hours >= 2 * p.minStaticHours ? 'refutes' : 'unknown';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '최근 정지 구간 수가 적거나 짧아 추정 불확실성이 큽니다. 더 긴 정지 보유(야간·주말)를 모아 다시 확인하세요.',
    refutes: '최근 정지 구간 수와 길이가 충분합니다.',
    unknown: '정지 구간 길이가 기준을 겨우 넘습니다.',
    no_data: '정지 구간이 없습니다.',
  };
  return makeCheck('hold_sufficiency', '구간 수·길이 충분성 (부족하면 불확실)', status, { recent_holds: recent.length, target_holds: p.recentHolds, median_hours: r(hours, 2), min_static_hours: p.minStaticHours }, notes[status]);
}

export function tankChecks(input: TankCheckInput): DiagnosticCheck[] {
  return [temperatureCheck(input), driftCheck(input), valveCheck(input), sufficiencyCheck(input)];
}

export interface HoldEvidenceInput {
  readonly reference: readonly HoldFit[];
  readonly recent: readonly HoldFit[];
  readonly leak: number;
  readonly ci: BootstrapResult;
  readonly noise: number;
  readonly threshold: number;
  readonly pctPerDay: number | null;
  readonly safety: boolean;
  readonly checks: readonly DiagnosticCheck[];
  readonly eos: H2Eos;
  readonly volumeM3: number;
  readonly p: TankStaticLeakParams;
}

const holdRow = (role: 'reference' | 'recent') => (f: HoldFit): JsonObject => ({
  role,
  start: f.hold.start,
  hours: r(f.hours, 2),
  loss_kg_per_day: r(f.lossKgPerDay, 4),
  ci_low: r(f.ciLowKgPerDay, 4),
  ci_high: r(f.ciHighKgPerDay, 4),
  t_mean_c: r(f.tempMeanC, 2),
  t_rate_c_per_day: r(f.tempRateCPerDay, 3),
  p_mean_bar: r(f.pressureMeanBar, 2),
});

/** 근거: 구간 표, 대표 구간(누설률이 결합값에 가장 가까운 최근 구간) P·T·보정 질량 곡선(≤120점) */
export function holdEvidence(e: HoldEvidenceInput): JsonObject {
  const representative = [...e.recent].sort((a, b) => Math.abs(a.lossKgPerDay - e.leak) - Math.abs(b.lossKgPerDay - e.leak))[0];
  const curve = representative ? downsample(representative.hold.points, 120).map((pt) => ({ ts: pt.ts, p_bar: r(pt.pressureBar, 3), t_c: r(pt.tempC, 2), mass_kg: r(e.eos.mass(pt.pressureBar, pt.tempC, e.volumeM3), 4) })) : [];
  return {
    method: 'static_hold_theil_sen_weighted_median',
    eos: e.eos.model === 'abel_noble' ? { model: 'abel_noble', specific_gas_constant: e.p.specificGasConstant, co_volume_m3_per_kg: e.p.coVolume, volume_m3: r(e.volumeM3, 4) } : { model: e.eos.model, volume_m3: r(e.volumeM3, 4) },
    combined: { leak_kg_per_day: r(e.leak, 4), ci_low: r(e.ci.ciLow, 4), ci_high: r(e.ci.ciHigh, 4), pct_per_day: r(e.pctPerDay, 3) },
    significance: { noise_sigma_kg_per_day: r(e.noise, 4), z_sigma: e.p.zSigma, threshold_kg_per_day: r(e.threshold, 4) },
    safety: { category_safety: e.safety, safety_kg_per_day: e.p.safetyKgPerDay, rule: '누설률 95% CI 하한 > 안전 기준일 때만 safety(severity 4)' },
    holds: [...e.reference.map(holdRow('reference')), ...e.recent.map(holdRow('recent'))].slice(-40),
    representative: representative ? { start: representative.hold.start, end: representative.hold.end, points: curve } : null,
    checks: [...e.checks],
    disclaimer: SAFETY_DISCLAIMER,
  };
}
