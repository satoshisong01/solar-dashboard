// h2chain.mass_balance_gap@2 — 사이트 수소 물질수지 잔차 (사이트 단위, assetId null).
// 입력은 일별 수소 원장(생산 + 외부 반입 − 연료전지 소비 − 저장량 변화 − 배출 추정 = 잔차). 필드 이름은 체인 원장 H2Ledger(om.site_energy_daily.h2_kg)와 같고,
// 판별 체크 보조값(faraday_expected·purge_count·tank_temp_delta_c)은 H2Ledger.aux에서 온다.
// 판정: 최근 recentDays일 잔차율 중앙값의 절댓값 > residualPct 이고, 기준 구간으로 표준화한 일 잔차율 CUSUM(같은 부호 방향)이 경보.
// 판별 체크: ① 유량계 드리프트(패러데이 기대 생산량 대비 유량계 비율 변화) ② 온도 보정 오차(잔차와 탱크 온도 변화·일교차 상관)
//           ③ 퍼지·배기 추정 부족(퍼지 횟수와 잔차 상관) ④ 저장부 누설 의심(tank.static_leak 결과와 교차 확인) ⑤ 데이터 결측일 ⑥ 반입 기록 누락.
// @2: 원장 식에 외부 반입(delivered)이 들어왔다. 반입 설비가 있는데 하역 계량·반입 기록이 없는 날은 원장이 residual을 null로 내므로
//     그날은 판정에서 빠진다(0으로 채우지 않는다) — 반입분을 손실로 오인해 상시 발화하던 구조적 오경보가 사라진다.
// severity 2, 누설 교차 확인이 '지지'면 3. 안전 판단은 tank.static_leak와 현장 안전설비 몫이다.
import * as z from 'zod';
import { downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { cusum, cusumPath, standardize } from '../stats/change';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { MAD_TO_SIGMA, mad, median } from '../stats/robust';
import { kstDateString, MS_PER_DAY, type JsonObject } from '../types';
import { levelCheck, makeCheck, medianOrNull, pearson, SAFETY_DISCLAIMER } from './check-helpers';
import { fixed, insufficient, r, signed, withDefaults } from './common';
import { completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import { recommended, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck, Severity } from './types';

/** 일별 수소 원장 한 줄 (KST 하루) */
export interface H2LedgerDayInput {
  /** KST 0시 epoch ms */
  readonly day: number;
  readonly produced: number | null;
  /** 외부 반입량 [kg]. 반입이 없는 사이트는 0, 반입 설비는 있는데 그날 계량·기록이 없으면 null (그날 residual도 null이다) */
  readonly delivered?: number | null;
  readonly fc_consumed: number | null;
  readonly stored_delta: number | null;
  readonly vented_est: number | null;
  readonly residual: number | null;
  readonly residual_pct: number | null;
  readonly dq: { readonly completeness: number | null };
  /** 판별 체크 보조 (없으면 해당 체크 데이터없음): 스택 전류로 계산한 이론 생산량 [kg] */
  readonly faraday_expected?: number | null;
  /** 퍼지 횟수 증가분 [회] */
  readonly purge_count?: number | null;
  /** 저장용기 가스 온도 하루 끝 − 시작 [°C] */
  readonly tank_temp_delta_c?: number | null;
  /** 외기 일교차 [°C] */
  readonly ambient_range_c?: number | null;
}

/** tank.static_leak 최근 결과 (사이트 저장용기 중 누설률이 가장 큰 것) */
export interface StaticLeakCrossCheck {
  readonly status: 'finding' | 'no_finding' | 'insufficient';
  readonly leakKgPerDay: number | null;
  readonly ciLowKgPerDay: number | null;
}

export interface H2MassBalanceInput {
  readonly siteId: number;
  readonly days: readonly H2LedgerDayInput[];
  readonly staticLeak?: StaticLeakCrossCheck | null;
}

export interface H2MassBalanceParams {
  readonly residualPct: number;
  readonly recentDays: number;
  readonly minRecentDays: number;
  readonly referenceDays: number;
  readonly minReferenceDays: number;
  readonly minCompleteness: number;
  readonly sigmaFloorPct: number;
  readonly cusumK: number;
  readonly cusumH: number;
  readonly flowmeterDriftPct: number;
  readonly correlationR: number;
  readonly trendDays: number;
  readonly leakShare: number;
  /** 최근 기간 결측·품질 미달일이 이 수 이상이면 결측 체크 지지 */
  readonly maxMissingDays: number;
  /** 최근 기간 중 반입량을 몰라 빠진 날이 이 수 이상이면 반입 기록 체크 지지 */
  readonly maxUnknownDeliveryDays: number;
  readonly iterations: number;
}

export const H2_MASS_BALANCE_DEFAULTS: H2MassBalanceParams = Object.freeze({
  residualPct: 2,
  recentDays: 7,
  minRecentDays: 5,
  referenceDays: 14,
  minReferenceDays: 7,
  minCompleteness: 0.9,
  sigmaFloorPct: 0.5,
  cusumK: 0.5,
  cusumH: 4,
  flowmeterDriftPct: 2,
  correlationR: 0.6,
  trendDays: 30,
  leakShare: 0.3,
  maxMissingDays: 2,
  maxUnknownDeliveryDays: 1,
  iterations: 1000,
});

const D = H2_MASS_BALANCE_DEFAULTS;
export const H2_MASS_BALANCE_PARAM_SCHEMA = z.object({
  residualPct: numParam(D.residualPct, { label: '잔차율 기준', unit: '%', min: 0.1, max: 50, description: '최근 기간 일 잔차율 중앙값의 절댓값이 이 값을 넘고 CUSUM 경보가 나면 finding입니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 3, max: 60, description: '잔차율 중앙값을 보는 최근 일수입니다.' }),
  minRecentDays: intParam(D.minRecentDays, { label: '최근 최소 유효일', unit: '일', min: 2, max: 60, description: '최근 기간 중 유효한 날이 이보다 적으면 판정 불능입니다.' }),
  referenceDays: intParam(D.referenceDays, { label: '기준 기간', unit: '일', min: 3, max: 180, description: '기준 창이 없을 때 첫 유효일부터 이 일수를 CUSUM 기준으로 씁니다.' }),
  minReferenceDays: intParam(D.minReferenceDays, { label: '기준 최소 유효일', unit: '일', min: 3, max: 180, description: '기준 유효일이 이보다 적으면 판정 불능입니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  sigmaFloorPct: numParam(D.sigmaFloorPct, { label: 'CUSUM σ 하한', unit: '%p', min: 0.01, max: 20, description: '기준 구간 잔차율 σ가 너무 작을 때 쓰는 하한입니다.' }),
  cusumK: numParam(D.cusumK, { label: 'CUSUM k', unit: 'σ', min: 0, max: 3, description: '표 CUSUM 허용 편차입니다.' }),
  cusumH: numParam(D.cusumH, { label: 'CUSUM h', unit: 'σ', min: 1, max: 20, description: '표 CUSUM 결정 경계입니다.' }),
  flowmeterDriftPct: numParam(D.flowmeterDriftPct, { label: '유량계 비율 변화 기준', unit: '%', min: 0.1, max: 50, description: '유량계 생산량 ÷ 패러데이 기대 생산량 비율이 기준 대비 이만큼 바뀌면 유량계 드리프트 체크를 지지로 봅니다.' }),
  correlationR: numParam(D.correlationR, { label: '상관 기준', unit: '', min: 0.1, max: 1, description: '잔차와 온도 변화·퍼지 횟수의 상관계수 절댓값이 이 값 이상이면 해당 체크를 지지로 봅니다.' }),
  trendDays: intParam(D.trendDays, { label: '상관 계산 기간', unit: '일', min: 7, max: 365, description: '상관계수를 계산하는 최근 일수입니다.' }),
  leakShare: numParam(D.leakShare, { label: '누설 설명 비율', unit: '', min: 0.05, max: 1, description: 'tank.static_leak 누설률이 일 잔차의 이 비율 이상을 설명하면 저장부 누설 체크를 지지로 봅니다.' }),
  maxMissingDays: intParam(D.maxMissingDays, { label: '결측일 기준', unit: '일', min: 0, max: 30, description: '최근 기간 결측·품질 미달일이 이 수 이상이면 데이터 결측 체크를 지지로 봅니다.' }),
  maxUnknownDeliveryDays: intParam(D.maxUnknownDeliveryDays, { label: '반입 기록 없는 날 기준', unit: '일', min: 0, max: 30, description: '최근 기간 중 하역 계량·반입 기록이 없어 판정에서 빠진 날이 이 수 이상이면 반입 기록 누락 체크를 지지로 봅니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'h2chain.mass_balance_gap', version: '2', failureMode: 'h2chain.mass_balance_gap', category: 'performance' } as const;

interface ValidDay extends H2LedgerDayInput {
  readonly residual: number;
  readonly residual_pct: number;
}

const isValid = (d: H2LedgerDayInput, p: H2MassBalanceParams): d is ValidDay => d.residual !== null && d.residual_pct !== null && Number.isFinite(d.residual_pct) && (d.dq.completeness ?? 0) >= p.minCompleteness;

function correlationCheck(id: string, label: string, days: readonly ValidDay[], pick: (d: ValidDay) => number | null | undefined, p: H2MassBalanceParams, notes: { supports: string; refutes: string }): DiagnosticCheck {
  const pairs = days.flatMap((d) => {
    const x = pick(d);
    return x === null || x === undefined || !Number.isFinite(x) ? [] : [[x, d.residual_pct] as const];
  });
  const rho = pairs.length >= 5 ? pearson(pairs.map(([x]) => x), pairs.map(([, y]) => y)) : null;
  return levelCheck(id, label, rho === null ? null : Math.abs(rho), [p.correlationR, 0.3], { n: pairs.length, pearson_r: r(rho, 3) }, {
    supports: notes.supports,
    refutes: notes.refutes,
    unknown: '상관이 약하게 있습니다.',
    no_data: '상관을 계산할 데이터가 부족합니다 (5일 이상 필요).',
  });
}

function checksOf(input: H2MassBalanceInput, reference: readonly ValidDay[], recent: readonly ValidDay[], trend: readonly ValidDay[], recentWindowDays: number, unknownDeliveryDays: number, p: H2MassBalanceParams): DiagnosticCheck[] {
  const ratio = (items: readonly ValidDay[]) => medianOrNull(items.flatMap((d) => (d.produced !== null && d.faraday_expected && d.faraday_expected > 0 ? [(d.produced / d.faraday_expected) * 100] : [])));
  const refRatio = ratio(reference);
  const curRatio = ratio(recent);
  const drift = refRatio === null || curRatio === null ? null : Math.abs(curRatio - refRatio);
  const flowmeter = levelCheck('flowmeter_drift', '유량계 드리프트 (패러데이 기대 생산량 대비)', drift, [p.flowmeterDriftPct, 0.5], { ref_ratio_pct: r(refRatio, 2), recent_ratio_pct: r(curRatio, 2) }, {
    supports: '같은 전류에서 유량계 생산량 비율이 바뀌었습니다. 유량계 영점·교정과 저유량 컷오프를 확인하세요.',
    refutes: '유량계 생산량과 전류 기대 생산량의 비율은 그대로입니다.',
    unknown: '유량계 비율이 조금 바뀌었습니다.',
    no_data: '패러데이 기대 생산량이 없어 비교할 수 없습니다.',
  });
  const temperature = correlationCheck('temperature_compensation', '온도 보정 오차 (잔차와 탱크 온도 변화 상관)', trend, (d) => d.tank_temp_delta_c ?? d.ambient_range_c, p, {
    supports: '잔차가 탱크 온도 변화·일교차와 함께 움직입니다. 재고 계산의 온도 보정(센서 위치·열 지연·절대압 변환)을 확인하세요.',
    refutes: '잔차는 온도 변화와 관계가 약합니다.',
  });
  const purge = correlationCheck('purge_vent_estimate', '퍼지·배기 추정 부족 (퍼지 횟수와 잔차 상관)', trend, (d) => d.purge_count, p, {
    supports: '퍼지가 많은 날 잔차가 큽니다. 퍼지 1회당 배출량 추정(kgPerPurge)과 미계량 벤트를 확인하세요.',
    refutes: '잔차는 퍼지 횟수와 관계가 약합니다.',
  });
  const leak = input.staticLeak ?? null;
  const dailyResidual = medianOrNull(recent.map((d) => d.residual));
  const share = leak?.status === 'finding' && leak.leakKgPerDay !== null && dailyResidual !== null && dailyResidual > 0 ? leak.leakKgPerDay / dailyResidual : null;
  const leakStatus = leak === null || leak.status === 'insufficient' ? 'no_data' : leak.status === 'no_finding' ? 'refutes' : share !== null && share >= p.leakShare && (leak.ciLowKgPerDay ?? 0) > 0 ? 'supports' : 'unknown';
  const storageLeak = makeCheck('storage_leak', '저장부 누설 의심 (정지 보유 누설률 교차 확인)', leakStatus, { static_leak_status: leak?.status ?? null, leak_kg_per_day: r(leak?.leakKgPerDay ?? null, 3), residual_kg_per_day: r(dailyResidual, 3), share: r(share, 3) }, {
    supports: `정지 보유 구간 누설률이 잔차의 상당 부분을 설명합니다. 저장부 누설 점검을 우선하세요. ${SAFETY_DISCLAIMER}`,
    refutes: '정지 보유 구간 누설 탐지 결과에서 누설이 확인되지 않았습니다.',
    unknown: '정지 보유 구간 누설 결과가 잔차를 충분히 설명하지 못합니다.',
    no_data: '저장용기 정지 보유 누설 판정 결과가 없습니다.',
  }[leakStatus]);
  const missing = Math.max(0, recentWindowDays - recent.length);
  const gaps = levelCheck('missing_days', '데이터 결측일', missing, [p.maxMissingDays, 0], { missing_or_low_quality_days: missing, window_days: recentWindowDays }, {
    supports: '최근 기간에 결측·품질 미달일이 많습니다. 계량 데이터 수집을 먼저 확인하세요.',
    refutes: '최근 기간에 결측일이 없습니다.',
    unknown: '최근 기간에 결측일이 조금 있습니다.',
    no_data: '결측일을 셀 수 없습니다.',
  });
  const delivery = levelCheck('delivery_record', '반입 기록 누락 (하역 계량·전표가 없어 뺀 날)', unknownDeliveryDays, [p.maxUnknownDeliveryDays, 0], { unknown_delivery_days: unknownDeliveryDays, window_days: recentWindowDays }, {
    supports: '최근 기간에 외부 반입량을 알 수 없어 판정에서 뺀 날이 있습니다. 하역 적산계(h2.delivery.mass.total)를 연결하거나 반입 기록을 입력하세요.',
    refutes: '최근 기간 모든 날의 외부 반입량이 계량 또는 전표로 확인됩니다.',
    unknown: '최근 기간에 반입량을 모르는 날이 조금 있습니다.',
    no_data: '반입량을 셀 수 없습니다.',
  });
  return [flowmeter, temperature, purge, storageLeak, gaps, delivery];
}

interface DaySplit {
  readonly inRange: readonly H2LedgerDayInput[];
  readonly valid: readonly ValidDay[];
  readonly reference: readonly ValidDay[];
  readonly recent: readonly ValidDay[];
}

function splitDays(input: H2MassBalanceInput, ctx: DetectorContext<H2MassBalanceParams>, p: H2MassBalanceParams): DaySplit {
  const from = ctx.baselineResetAt ?? -Infinity;
  const inRange = input.days.filter((d) => d.day >= from && d.day + MS_PER_DAY <= ctx.now).sort((a, b) => a.day - b.day);
  const valid = inRange.filter((d): d is ValidDay => isValid(d, p));
  const window = ctx.referenceWindow;
  const reference = window ? valid.filter((d) => d.day >= window.start && d.day < window.end) : valid.filter((d) => d.day < (valid[0]?.day ?? 0) + p.referenceDays * MS_PER_DAY);
  const referenceEnd = (reference.at(-1)?.day ?? Infinity) + MS_PER_DAY;
  const recent = valid.filter((d) => d.day >= ctx.now - p.recentDays * MS_PER_DAY && d.day >= referenceEnd);
  return { inRange, valid, reference, recent };
}

interface Alarm {
  readonly currentPct: number;
  readonly direction: 'up' | 'down';
  readonly alarmDay: number | null;
  readonly changeStartDay: number | null;
  /** 기준 시작 이후 유효일과 그 표준화 잔차율 (근거 CUSUM 경로용) */
  readonly monitored: readonly ValidDay[];
  readonly z: readonly number[];
}

/** 최근 잔차율 중앙값이 기준을 넘고, 기준 구간으로 표준화한 CUSUM(같은 부호 방향)이 경보를 내면 경보 정보. 아니면 null */
function alarmOf(split: DaySplit, p: H2MassBalanceParams): Alarm | null {
  const currentPct = median(split.recent.map((d) => d.residual_pct));
  if (!(Math.abs(currentPct) > p.residualPct)) return null;
  const direction = currentPct > 0 ? 'up' : 'down';
  const monitored = split.valid.filter((d) => d.day >= (split.reference[0]?.day ?? 0));
  const z = standardize(monitored.map((d) => d.residual_pct), split.reference.map((d) => d.residual_pct), p.sigmaFloorPct);
  const change = cusum(z, { k: p.cusumK, h: p.cusumH, direction });
  if (change.alarmIndex === null) return null;
  return { currentPct, direction, alarmDay: monitored[change.alarmIndex]?.day ?? null, changeStartDay: change.changeStartIndex === null ? null : (monitored[change.changeStartIndex]?.day ?? null), monitored, z };
}

/** 근거 CUSUM 경로: 기준 시작 이후 유효일마다 경보 방향 누적합 (≤120점) */
function cusumPoints(alarm: Alarm, p: H2MassBalanceParams): JsonObject[] {
  const path = cusumPath(alarm.z, { k: p.cusumK, direction: alarm.direction });
  return downsample(alarm.monitored.map((d, i) => ({ date: kstDateString(d.day), s: r(path[i] ?? 0, 3) })), 120);
}

function buildFinding(input: H2MassBalanceInput, ctx: DetectorContext<H2MassBalanceParams>, p: H2MassBalanceParams, split: DaySplit, alarm: Alarm): CandidateFinding {
  const { reference, recent } = split;
  const { currentPct } = alarm;
  const ci = bootstrapCI(recent.map((d) => d.residual_pct), median, { iterations: p.iterations, rng: ctx.rng });
  const unknownDelivery = split.inRange.filter((d) => d.day >= ctx.now - p.recentDays * MS_PER_DAY && (d.delivered ?? null) === null && d.residual === null).length;
  const checks = checksOf(input, reference, recent, split.valid.filter((d) => d.day >= ctx.now - p.trendDays * MS_PER_DAY), p.recentDays, unknownDelivery, p);
  const severity: Severity = checks.find((c) => c.id === 'storage_leak')?.status === 'supports' ? 3 : 2;
  const referencePct = median(reference.map((d) => d.residual_pct));
  const residualKgDay = median(recent.map((d) => d.residual));
  const producedDay = medianOrNull(recent.flatMap((d) => d.produced ?? []));
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const evidence: JsonObject = {
    method: 'residual_median_cusum',
    sign_convention: 'residual = produced + delivered − fc_consumed − stored_delta − vented_est (양수 = 계량되지 않은 손실 또는 공급 과다 계량). 반입량을 모르는 날은 0으로 채우지 않고 판정에서 뺀다',
    reference: { days: reference.length, from: reference[0]?.day ?? null, median_pct: r(referencePct, 3), sigma_pct: r(Math.max(MAD_TO_SIGMA * mad(reference.map((d) => d.residual_pct)), p.sigmaFloorPct), 3) },
    recent: { days: recent.length, from: recent[0]?.day ?? null, median_pct: r(currentPct, 3), median_kg: r(residualKgDay, 3) },
    cusum: { direction: alarm.direction, alarm_day: alarm.alarmDay === null ? null : kstDateString(alarm.alarmDay), change_start_day: alarm.changeStartDay === null ? null : kstDateString(alarm.changeStartDay), k: p.cusumK, h: p.cusumH, sigma_floor_pct: p.sigmaFloorPct, points: cusumPoints(alarm, p) },
    days: downsample(split.inRange, 120).map((d) => ({ date: kstDateString(d.day), produced: r(d.produced, 2), delivered: r(d.delivered ?? null, 2), fc_consumed: r(d.fc_consumed, 2), stored_delta: r(d.stored_delta, 2), vented_est: r(d.vented_est, 3), residual: r(d.residual, 3), residual_pct: r(d.residual_pct, 2), completeness: r(d.dq.completeness, 3) })),
    checks,
    note: `청정수소 인증 공식 산정이 아닙니다. ${SAFETY_DISCLAIMER}`,
  };
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: null,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: recent.length, ciWidth: relativeCiWidth(currentPct, ci.ciLow, ci.ciHigh), dqCompleteness: median(recent.map((d) => d.dq.completeness ?? 0)), methodsAgree: true }),
    title: `수소 물질수지 잔차 ${signed(currentPct, 1)}%`,
    summary:
      `최근 ${p.recentDays}일 중 유효 ${recent.length}일의 수소 물질수지 잔차율 중앙값이 ${signed(currentPct, 1)}%(95% CI ${signed(ci.ciLow, 1)} ~ ${signed(ci.ciHigh, 1)}%, 하루 약 ${fixed(residualKgDay, 2)} kg${producedDay === null ? '' : ` / 생산 ${fixed(producedDay, 1)} kg`})로 기준 ${fixed(p.residualPct, 1)}%를 넘고, 기준 기간 대비 CUSUM 경보가 났습니다.` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'h2_residual_pct', value: r(currentPct, 3) ?? 0, unit: '%', ciLow: r(ci.ciLow, 3), ciHigh: r(ci.ciHigh, 3), baseline: r(referencePct, 3), current: r(currentPct, 3), levelUnit: '%' },
    windowStart: reference[0]?.day ?? ctx.now,
    windowEnd: (recent.at(-1)?.day ?? ctx.now) + MS_PER_DAY,
    evidence,
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, days: split.inRange, staticLeak: input.staticLeak ?? null }),
  };
}

function detect(input: H2MassBalanceInput, ctx: DetectorContext<H2MassBalanceParams>): DetectorResult {
  const p = withDefaults(H2_MASS_BALANCE_DEFAULTS, ctx.params);
  const split = splitDays(input, ctx, p);
  if (split.reference.length < p.minReferenceDays || split.recent.length < p.minRecentDays) {
    return insufficient(`유효한 수소 원장 일수 부족: 기준 ${split.reference.length}일·최근 ${split.recent.length}일 (각 ${p.minReferenceDays}·${p.minRecentDays}일 필요, 완결성 ${fixed(p.minCompleteness * 100, 0)}% 이상)`);
  }
  const alarm = alarmOf(split, p);
  return { status: 'ok', findings: alarm === null ? [] : [buildFinding(input, ctx, p, split, alarm)] };
}

export const h2ChainMassBalanceGap: Detector<H2MassBalanceInput, H2MassBalanceParams> = {
  ...META,
  requires: {
    assetClass: ['h2.elz', 'h2.storage.tank', 'fc.plant'],
    metrics: [
      required('h2.flow.mass', SLOW_S), // 일 생산량 적산 (적산계가 없을 때의 대체 경로)
      required('fc.h2.consumption', SLOW_S), // 일 소비량 적산
      required('tank.pressure', SLOW_S), // 일 경계 재고 (상태식). 자정 전후 몇 분의 차이는 잔차에 묻힌다
      required('tank.temp', SLOW_S), // 재고 온도 보정
      recommended('h2.mass.total', SLOW_S), // 적산계 일 증가량 — 생산량 1순위. 없으면 유량 적산으로 대체(건강 사이트 일 잔차율 p95 0.3% → 2.1%)
      recommended('purge.count', SLOW_S), // 판별 체크 ③ 배출 추정. 없으면 배출을 0으로 둔다
      recommended('h2.delivery.mass.total', SLOW_S), // 외부 반입 적산 — 반입 설비가 있는 사이트에서 이게 없으면 반입 기록(om.h2_delivery)이 있는 날만 판정한다
    ],
    minHistoryDays: 21,
  },
  defaultParams: H2_MASS_BALANCE_DEFAULTS,
  paramSchema: H2_MASS_BALANCE_PARAM_SCHEMA,
  detect,
};
