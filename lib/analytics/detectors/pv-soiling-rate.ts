// pv.soiling_rate@1 — 태양광 오염 속도·누적 손실 (사이트 단위 또는 pv.plant 설비).
// 맑은 날 온도 보정 성능지수(PI)를 세척·강우 복원 시점으로 나눈 구간마다 Theil–Sen 기울기 → 오염 속도 %/일, 현재 구간 누적 손실 %.
// finding: 현재 구간 기울기 95% CI가 0 아래(손실 증가가 유의)이고 누적 손실 ≥ sev2LossPct. severity 누적 손실 2% → 2, 4% → 3 (성능 카테고리, 3 상한).
// 판별 체크: ① 사이트 전체 동시 저하(모든 인버터 → 오염·일사계 오염) vs 일부(→ pv.inverter_peer 몫) ② 일사계 자체 오염·드리프트(GHI/POA 비율 변화)
//           ③ 계절 입사각 영향(전년 같은 기간 기울기, 없으면 불명) ④ 복원 이벤트 후 회복 폭.
// 권고 문장: 누적 손실 kWh × SMP(market_daily 최근값, 없으면 '가격 데이터 없음') vs 세척비(params.cleaningCostKrw).
import * as z from 'zod';
import type { PvDayEpisode } from '../episodes/pv';
import { downsample } from '../episodes/series';
import type { WxDayEpisode } from '../episodes/wx-day';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { kstDateString, MS_PER_DAY, type JsonObject } from '../types';
import { fixed, insufficient, r, withDefaults } from './common';
import { intParam, numParam } from './param-schema';
import { soilingChecks } from './pv-soiling-checks';
import { findResets, lossPctAt, piDays, segmentsOf, type PiDay, type Reset, type Segment } from './pv-soiling-days';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, Severity } from './types';

export interface PvSoilingInput {
  readonly siteId: number;
  /** pv.plant 설비 id (사이트 단위면 null) */
  readonly assetId: number | null;
  /** 명판 모듈 온도계수 [1/°C]. 없으면 params.gammaPerC */
  readonly gammaPerC: number | null;
  readonly inverterDays: readonly PvDayEpisode[];
  readonly wxDays: readonly WxDayEpisode[];
  /** 세척 시각 (asset_event·maintenance_action에서 load 계층이 고른다) */
  readonly cleaningTs: readonly number[];
  /** 최근 SMP [원/kWh] (market_daily). 없으면 null */
  readonly smpKrwPerKwh: number | null;
}

export interface PvSoilingParams {
  readonly gammaPerC: number;
  readonly clearDayRatio: number;
  readonly maxVariability: number;
  readonly clearVariabilityQuantile: number;
  readonly envelopeHalfDays: number;
  readonly minCompleteness: number;
  readonly peerZ: number;
  readonly minEligibleShare: number;
  readonly recoveryStepPct: number;
  readonly stepWindowDays: number;
  readonly minSegmentDays: number;
  readonly minClearDays: number;
  readonly sev2LossPct: number;
  readonly sev3LossPct: number;
  readonly cleaningCostKrw: number;
  readonly siteWideShare: number;
  readonly sensorRatioShiftPct: number;
}

export const PV_SOILING_DEFAULTS: PvSoilingParams = Object.freeze({
  gammaPerC: -0.0035,
  clearDayRatio: 0.8,
  maxVariability: 1.3,
  clearVariabilityQuantile: 0.2,
  envelopeHalfDays: 15,
  minCompleteness: 0.9,
  peerZ: 3.5,
  minEligibleShare: 0.5,
  recoveryStepPct: 1.5,
  stepWindowDays: 2,
  minSegmentDays: 14,
  minClearDays: 6,
  sev2LossPct: 2,
  sev3LossPct: 4,
  cleaningCostKrw: 3_000_000,
  siteWideShare: 0.75,
  sensorRatioShiftPct: 3,
});

const D = PV_SOILING_DEFAULTS;
export const PV_SOILING_PARAM_SCHEMA = z.object({
  gammaPerC: numParam(D.gammaPerC, { label: '모듈 온도계수 γ', unit: '1/°C', min: -0.01, max: 0, description: '명판 값이 없을 때 쓰는 최대출력 온도계수입니다 (결정질 실리콘 약 −0.0035).' }),
  clearDayRatio: numParam(D.clearDayRatio, { label: '맑은 날 일사 비율', unit: '', min: 0.3, max: 1, description: 'POA 일적산이 계절 청천 상한(앞뒤 기간 최대)의 이 비율 이상인 날만 맑은 날로 봅니다.' }),
  maxVariability: numParam(D.maxVariability, { label: '일중 변동 상한', unit: '', min: 1, max: 5, description: 'Σ|ΔPOA| ÷ (2 × 최대 POA)가 이 값 이하인 날은 맑은 날 후보입니다 (맑은 날 ≈ 1).' }),
  clearVariabilityQuantile: numParam(D.clearVariabilityQuantile, { label: '맑은 날 변동 분위', unit: '', min: 0, max: 1, description: '앞뒤 기간 일중 변동 지표의 이 분위 이하인 날도 맑은 날 후보로 봅니다 (운량 변동이 늘 있는 기후 대응, 0이면 고정 상한만).' }),
  envelopeHalfDays: intParam(D.envelopeHalfDays, { label: '청천 상한 기간(앞뒤)', unit: '일', min: 3, max: 60, description: '계절 청천 상한을 잡는 앞뒤 일수입니다.' }),
  minCompleteness: numParam(D.minCompleteness, { label: '인버터 최소 완결성', unit: '', min: 0, max: 1, description: '그날 인버터 데이터 완결성이 이 값 미만이면 합계에서 뺍니다.' }),
  peerZ: numParam(D.peerZ, { label: '동종 이상 인버터 수정 z', unit: '', min: 1, max: 10, description: '그날 동종 대비 수정 z가 −이 값보다 작은 인버터는 합계에서 뺍니다 (고장은 pv.inverter_peer 몫).' }),
  minEligibleShare: numParam(D.minEligibleShare, { label: '유효 인버터 비율', unit: '', min: 0.1, max: 1, description: '그날 제외하고 남은 인버터 비율이 이 값 미만이면 그날 PI를 계산하지 않습니다.' }),
  recoveryStepPct: numParam(D.recoveryStepPct, { label: '복원 급상승 기준', unit: '%', min: 0.2, max: 20, description: '맑은 날 PI 중앙값이 앞 대비 이 비율 이상 뛰면 강우·세척 복원으로 봅니다 (강수량 메트릭이 없을 때).' }),
  stepWindowDays: intParam(D.stepWindowDays, { label: '복원 비교 맑은 날 수', unit: '일', min: 1, max: 10, description: '복원 판정에 앞·뒤 각각 쓰는 맑은 날 수입니다.' }),
  minSegmentDays: intParam(D.minSegmentDays, { label: '최소 무세척 구간', unit: '일', min: 7, max: 180, description: '복원 이후 이 일수 이상 지난 구간만 오염 속도를 판정합니다.' }),
  minClearDays: intParam(D.minClearDays, { label: '구간 최소 맑은 날', unit: '일', min: 3, max: 100, description: '구간 안 맑은 날이 이보다 적으면 기울기를 계산하지 않습니다.' }),
  sev2LossPct: numParam(D.sev2LossPct, { label: 'severity 2 누적 손실', unit: '%', min: 0.1, max: 50, description: '현재 구간 누적 오염 손실이 이 값 이상이고 기울기가 유의하면 finding(severity 2)입니다.' }),
  sev3LossPct: numParam(D.sev3LossPct, { label: 'severity 3 누적 손실', unit: '%', min: 0.1, max: 50, description: '이 값 이상이면 severity 3입니다 (성능 카테고리라 3이 상한).' }),
  cleaningCostKrw: numParam(D.cleaningCostKrw, { label: '세척 1회 비용', unit: '원', min: 0, max: 1_000_000_000, description: '세척 경제성 문장에 쓰는 사이트 세척 1회 비용입니다 (추정 초기값).' }),
  siteWideShare: numParam(D.siteWideShare, { label: '사이트 전체 저하 비율', unit: '', min: 0.1, max: 1, description: '이 비율 이상의 인버터가 함께 떨어지면 사이트 전체 동시 저하로 봅니다.' }),
  sensorRatioShiftPct: numParam(D.sensorRatioShiftPct, { label: 'GHI/POA 비율 변화 기준', unit: '%', min: 0.1, max: 50, description: '구간 앞·뒤 GHI/POA 비율이 이만큼 바뀌면 일사계 오염·드리프트 체크를 지지로 봅니다.' }),
});

const META = { id: 'pv.soiling_rate', version: '1', failureMode: 'pv.soiling', category: 'performance' } as const;

interface Economics {
  readonly cumulativeLossKwh: number;
  readonly dailyLossKwh: number;
  readonly lossValueKrw: number | null;
  readonly sentence: string;
}

function economicsOf(days: readonly PiDay[], segment: Segment, smp: number | null, p: PvSoilingParams): Economics {
  const inside = days.filter((d) => d.day >= segment.from && d.day < segment.to);
  const lossOf = (d: PiDay) => {
    const frac = Math.min(0.9, lossPctAt(segment, d.day) / 100);
    return (d.acKwh * frac) / (1 - frac);
  };
  const cumulative = inside.reduce((sum, d) => sum + lossOf(d), 0);
  const recent = inside.slice(-7);
  const daily = recent.length === 0 ? 0 : recent.reduce((sum, d) => sum + lossOf(d), 0) / recent.length;
  if (smp === null) return { cumulativeLossKwh: cumulative, dailyLossKwh: daily, lossValueKrw: null, sentence: ` 누적 손실 약 ${fixed(cumulative, 0)} kWh(하루 약 ${fixed(daily, 0)} kWh)로 추정됩니다. 가격 데이터 없음 — 세척 경제성은 SMP 입력 후 판단하세요.` };
  const value = cumulative * smp;
  const share = p.cleaningCostKrw > 0 ? (value / p.cleaningCostKrw) * 100 : null;
  const verdict = share !== null && share >= 100 ? ' 누적 손실액이 세척비를 넘었으니 세척을 검토하세요.' : share === null ? '' : ` 세척비 ${fixed(p.cleaningCostKrw, 0)}원의 ${fixed(share, 0)}%입니다.`;
  return { cumulativeLossKwh: cumulative, dailyLossKwh: daily, lossValueKrw: value, sentence: ` 누적 손실 약 ${fixed(cumulative, 0)} kWh(SMP ${fixed(smp, 1)}원/kWh 기준 약 ${fixed(value, 0)}원, 하루 약 ${fixed(daily * smp, 0)}원)로 추정됩니다.${verdict}` };
}

function evidenceOf(days: readonly PiDay[], resets: readonly Reset[], segments: readonly Segment[], current: Segment, economics: Economics, extra: JsonObject): JsonObject {
  const clear = days.filter((d) => d.clear);
  const last = current.clearDays.at(-1)?.day ?? current.from;
  return {
    method: 'clear_day_pi_theil_sen_segments',
    pi_points: downsample(clear, 120).map((d) => ({ date: kstDateString(d.day), pi: r(d.pi, 4) })),
    current_line: [current.from, last].map((day) => ({ date: kstDateString(day), pi: r(current.intercept + current.slope * ((day - current.from) / MS_PER_DAY), 4) })),
    segments: segments.slice(-20).map((s) => ({ from: kstDateString(s.from), to: kstDateString(s.to), clear_days: s.clearDays.length, rate_pct_per_day: r(s.ratePctPerDay, 4), ci_low: r(s.rateCiLow, 4), ci_high: r(s.rateCiHigh, 4) })),
    resets: resets.slice(-30).map((reset) => ({ date: kstDateString(reset.day), kind: reset.kind, recovery_pct: r(reset.recoveryPct, 2) })),
    economics: { cumulative_loss_kwh: r(economics.cumulativeLossKwh, 1), daily_loss_kwh: r(economics.dailyLossKwh, 1), loss_value_krw: r(economics.lossValueKrw, 0) },
    ...extra,
  };
}

function detect(input: PvSoilingInput, ctx: DetectorContext<PvSoilingParams>): DetectorResult {
  const p = withDefaults(PV_SOILING_DEFAULTS, ctx.params);
  const gamma = input.gammaPerC ?? p.gammaPerC;
  const from = ctx.baselineResetAt ?? -Infinity;
  const inRange = <T extends { readonly start: number; readonly end: number }>(items: readonly T[]) => items.filter((e) => e.start >= from && e.end <= ctx.now);
  const { days, exclusions } = piDays(inRange(input.inverterDays), inRange(input.wxDays), { ...p, gammaPerC: gamma });
  const clear = days.filter((d) => d.clear);
  const resets = findResets(clear, input.cleaningTs.filter((ts) => ts >= from && ts <= ctx.now), p);
  const segments = segmentsOf(clear, resets, p.minClearDays, ctx.now);
  const current = segments.at(-1);
  const lastReset = resets.at(-1)?.day ?? -Infinity;
  if (!current || current.to < ctx.now) return insufficient(`현재 무세척 구간의 맑은 날이 부족합니다 (맑은 날 ${clear.filter((d) => d.day >= lastReset).length}일, ${p.minClearDays}일 필요)`);
  const spanDays = ((current.clearDays.at(-1)?.day ?? current.from) - current.from) / MS_PER_DAY;
  if (spanDays < p.minSegmentDays) return insufficient(`현재 무세척 구간이 짧습니다 (${fixed(spanDays, 0)}일, ${p.minSegmentDays}일 필요)`);
  const lastDay = current.clearDays.at(-1)?.day ?? current.from;
  const lossPct = lossPctAt(current, lastDay);
  if (!(current.rateCiLow > 0) || lossPct < p.sev2LossPct) return { status: 'ok', findings: [] };

  const severity: Severity = lossPct >= p.sev3LossPct ? 3 : 2;
  const lossCiLow = Math.max(0, (current.rateCiLow * (lastDay - current.from)) / MS_PER_DAY);
  const lossCiHigh = (current.rateCiHigh * (lastDay - current.from)) / MS_PER_DAY;
  const economics = economicsOf(days, current, input.smpKrwPerKwh, p);
  const checks = soilingChecks({ days, current, lossPct, ratePctPerDay: current.ratePctPerDay, lastReset: resets.at(-1) ?? null, p });
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const restoreText = resets.length === 0 ? '데이터 시작' : `마지막 복원(${kstDateString(lastReset)})`;
  const finding: CandidateFinding = {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: current.clearDays.length, ciWidth: relativeCiWidth(current.ratePctPerDay, current.rateCiLow, current.rateCiHigh), dqCompleteness: 1, methodsAgree: checks[0]?.status === 'refutes' ? false : null }),
    title: `태양광 오염 손실 약 ${fixed(lossPct, 1)}% (오염 속도 ${fixed(current.ratePctPerDay, 2)}%/일)`,
    summary:
      `맑은 날 ${current.clearDays.length}일의 온도 보정 성능지수(PI)로 보면 ${restoreText} 이후 ${fixed(spanDays, 0)}일 동안 오염 속도 ${fixed(current.ratePctPerDay, 2)}%/일(95% CI ${fixed(current.rateCiLow, 2)} ~ ${fixed(current.rateCiHigh, 2)}), 현재 누적 손실 약 ${fixed(lossPct, 1)}%입니다.` +
      economics.sentence +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'soiling_loss_pct', value: r(lossPct, 3) ?? 0, unit: '%', ciLow: r(lossCiLow, 3), ciHigh: r(lossCiHigh, 3), baseline: r(current.intercept, 4), current: r(current.intercept + current.slope * ((lastDay - current.from) / MS_PER_DAY), 4), levelUnit: 'PI' },
    windowStart: current.from,
    windowEnd: lastDay + MS_PER_DAY,
    evidence: evidenceOf(days, resets, segments, current, economics, { rate_pct_per_day: r(current.ratePctPerDay, 4), gamma_per_c: gamma, exclusions: { ...exclusions, cloudy_days: days.length - clear.length }, smp_krw_per_kwh: input.smpKrwPerKwh, cleaning_cost_krw: p.cleaningCostKrw, checks }),
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, gamma, days: days.map((d) => [d.day, d.pi, d.clear]), cleaning: input.cleaningTs, smp: input.smpKrwPerKwh }),
  };
  return { status: 'ok', findings: [finding] };
}

export const pvSoilingRate: Detector<PvSoilingInput, PvSoilingParams> = {
  ...META,
  requires: { assetClass: ['pv.plant', 'pv.inverter', 'wx.station'], metrics: ['ac.power', 'ac.power.limit', 'op.state', 'poa.irradiance', 'module.temp'], minPeriodS: 300, minHistoryDays: 30 },
  defaultParams: PV_SOILING_DEFAULTS,
  paramSchema: PV_SOILING_PARAM_SCHEMA,
  detect,
};
