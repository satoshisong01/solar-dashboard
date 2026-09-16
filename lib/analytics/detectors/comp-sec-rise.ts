// comp.sec_rise@1 — 수소 압축기 비에너지(kWh/kg) 상승.
// comp.run 에피소드의 비에너지를 압력비 bin × 흡입온도(외기) bin으로 나눠 기준 vs 최근 30일 matchedRatio + 누적 운전시간 추세.
// 판별 체크: ① 같은 압력비에서 토출 온도 상승(내부 누설·재압축 → 밸브·피스톤링 마모) ② 누설 감지 압력 상승(다이어프램·디스턴스 피스)
//           ③ 진동 증가 ④ 냉각 부족(외기 온도 bin 편중).
// 누설 감지 압력 급상승은 별도 safety finding으로 올리지 않는다 — 판별 체크 '지지'와 권고 문구만 남기고 안전 판단은 현장 인터록 몫이다.
import * as z from 'zod';
import type { CompRunEpisode } from '../episodes/compressor';
import { binFloor } from '../episodes/series';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import { levelCheck, medianChangePct, medianShift, SAFETY_DISCLAIMER } from './check-helpers';
import { fixed, insufficient, r, signed, withDefaults } from './common';
import { binWeightedShift, compareRise, riseEvidence, riseParamShape, riseWindow, trendAgrees, type RiseParams, type RiseResult, type RiseSample } from './matched-rise';
import { completenessParam, numParam } from './param-schema';
import { recommended, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck } from './types';

export interface CompSecRiseInput {
  readonly assetId: number;
  readonly episodes: readonly CompRunEpisode[];
}

export interface CompSecRiseParams extends RiseParams {
  readonly ratioBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minMassKg: number;
  readonly minCompleteness: number;
  readonly dischargeTempRiseC: number;
  readonly leakPressureRiseBar: number;
  readonly leakPressureAlertBar: number;
  readonly vibrationRisePct: number;
  readonly ambientShiftC: number;
}

export const COMP_SEC_RISE_DEFAULTS: CompSecRiseParams = Object.freeze({
  referencePerBin: 10,
  maxReferenceSpreadDays: 120,
  recentDays: 30,
  minPerBin: 5,
  minTotal: 15,
  iterations: 1000,
  sev2Pct: 5,
  sev3Pct: 10,
  sev4Pct: 20,
  ratioBinWidth: 2,
  tempBinWidthC: 5,
  minMassKg: 5,
  minCompleteness: 0.8,
  dischargeTempRiseC: 5,
  leakPressureRiseBar: 0.2,
  leakPressureAlertBar: 0.5,
  vibrationRisePct: 20,
  ambientShiftC: 5,
});

const D = COMP_SEC_RISE_DEFAULTS;
export const COMP_SEC_RISE_PARAM_SCHEMA = z.object({
  ...riseParamShape(D, '압축기 비에너지'),
  ratioBinWidth: numParam(D.ratioBinWidth, { label: '압력비 bin 폭', unit: '', min: 0.1, max: 50, description: '같은 조건 비교에 쓰는 토출/흡입 압력비 구간 폭입니다.' }),
  tempBinWidthC: numParam(D.tempBinWidthC, { label: '흡입(외기) 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '흡입 가스 온도 대신 외기 온도로 나누는 구간 폭입니다.' }),
  minMassKg: numParam(D.minMassKg, { label: '운전 최소 이송량', unit: 'kg', min: 0, max: 1000, description: '이송 질량이 이보다 적은 짧은 보충 운전은 기동·정지 에너지 비중이 커서(1~2 kg 운전은 정상 운전의 약 1.5배 비에너지) 같은 조건이 아니므로 뺍니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  dischargeTempRiseC: numParam(D.dischargeTempRiseC, { label: '토출 온도 상승 기준', unit: '°C', min: 0.5, max: 50, description: '같은 압력비 bin에서 토출 온도 중앙값이 이만큼 오르면 내부 누설·재압축 체크를 지지로 봅니다.' }),
  leakPressureRiseBar: numParam(D.leakPressureRiseBar, { label: '누설 감지 압력 상승 기준', unit: 'bar', min: 0.01, max: 50, description: '운전 중 누설 감지 압력 최댓값 중앙값이 이만큼 오르면 누설 감지 체크를 지지로 봅니다.' }),
  leakPressureAlertBar: numParam(D.leakPressureAlertBar, { label: '누설 감지 압력 주의값', unit: 'bar', min: 0.01, max: 100, description: '최근 운전 중 누설 감지 압력이 이 값 이상이면 상승폭과 관계없이 지지로 봅니다 (안전 판단은 현장 인터록 몫).' }),
  vibrationRisePct: numParam(D.vibrationRisePct, { label: '진동 증가 기준', unit: '%', min: 1, max: 500, description: '진동 RMS 중앙값이 이 비율 이상 늘면 진동 체크를 지지로 봅니다.' }),
  ambientShiftC: numParam(D.ambientShiftC, { label: '외기 온도 편중 기준', unit: '°C', min: 0.5, max: 30, description: '최근 운전 외기 온도 중앙값이 기준보다 이만큼 높으면 냉각 부족 체크를 지지로 봅니다.' }),
});

const META = { id: 'comp.sec_rise', version: '1', failureMode: 'comp.efficiency_loss', category: 'performance' } as const;

function samplesOf(input: CompSecRiseInput, ctx: DetectorContext<CompSecRiseParams>, p: CompSecRiseParams): RiseSample[] {
  const from = ctx.baselineResetAt ?? -Infinity;
  return input.episodes.flatMap((e) => {
    const f = e.features;
    if (!e.valid || f.sec_kwh_per_kg === null || !(f.sec_kwh_per_kg > 0) || f.pressure_ratio === null || (f.mass_kg ?? 0) < p.minMassKg) return [];
    if (e.dq.completeness < p.minCompleteness || e.start < from || e.end > ctx.now) return [];
    const tKey = f.ambient_c === null ? 'na' : String(binFloor(f.ambient_c, p.tempBinWidthC));
    return [{ start: e.start, end: e.end, value: f.sec_kwh_per_kg, weight: 1, bin: `${binFloor(f.pressure_ratio, p.ratioBinWidth)}|${tKey}`, completeness: e.dq.completeness, axis: f.op_hours_cum }];
  });
}

type Feature = keyof CompRunEpisode['features'];

function checksOf(result: RiseResult, byStart: ReadonlyMap<number, CompRunEpisode>, p: CompSecRiseParams): DiagnosticCheck[] {
  const feature = (s: RiseSample, key: Feature): number | null => {
    const value = byStart.get(s.start)?.features[key];
    return typeof value === 'number' ? value : null;
  };
  const values = (samples: readonly RiseSample[], key: Feature) => samples.flatMap((s) => feature(s, key) ?? []);

  const temp = binWeightedShift(result, (s) => feature(s, 'discharge_temp_c'));
  const dischargeTemp = levelCheck('discharge_temp', '같은 압력비에서 토출 온도 상승 (내부 누설·재압축)', temp?.shift ?? null, [p.dischargeTempRiseC, 1.5], { ref_c: r(temp?.ref ?? null, 2), recent_c: r(temp?.cur ?? null, 2), shift_c: r(temp?.shift ?? null, 2) }, {
    supports: '같은 압력비에서 토출 온도가 올랐습니다. 흡입·토출 밸브 누설이나 피스톤링·패킹 마모로 가스가 재압축될 수 있습니다.',
    refutes: '같은 압력비에서 토출 온도는 그대로입니다.',
    unknown: '토출 온도가 조금 올랐습니다.',
    no_data: '토출 온도 데이터가 없습니다.',
  });

  const leakCur = values(result.recent, 'leak_pressure_max_bar');
  const leakShift = medianShift(values(result.reference, 'leak_pressure_max_bar'), leakCur);
  const leakMax = leakCur.length === 0 ? null : Math.max(...leakCur);
  // 주의값 이상이면 상승폭과 관계없이 지지 (levelStatus에 넘기는 값을 지지 기준으로 끌어올린다)
  const leakLevel = leakShift === null ? null : leakMax !== null && leakMax >= p.leakPressureAlertBar ? Math.max(leakShift.shift, p.leakPressureRiseBar) : leakShift.shift;
  const leak = levelCheck('leak_pressure', '누설 감지 압력 상승 (다이어프램·디스턴스 피스)', leakLevel, [p.leakPressureRiseBar, 0.05], { ref_bar: r(leakShift?.ref ?? null, 3), recent_bar: r(leakShift?.cur ?? null, 3), recent_max_bar: r(leakMax, 3) }, {
    supports: `누설 감지 압력이 올랐습니다. 제조사 절차와 현장 인터록 상태를 즉시 확인하세요. ${SAFETY_DISCLAIMER}`,
    refutes: '누설 감지 압력은 그대로입니다.',
    unknown: '누설 감지 압력이 조금 올랐습니다.',
    no_data: '누설 감지 압력 데이터가 없습니다.',
  });

  const vibChange = medianChangePct(values(result.reference, 'vibration_mm_s'), values(result.recent, 'vibration_mm_s'));
  const vibration = levelCheck('vibration', '진동 증가', vibChange, [p.vibrationRisePct, 5], { change_pct: r(vibChange, 1) }, {
    supports: '진동이 늘었습니다. 베어링·크랭크·체결부와 밸브 상태를 점검하세요.',
    refutes: '진동은 늘지 않았습니다.',
    unknown: '진동이 조금 늘었습니다.',
    no_data: '진동 데이터가 없습니다 (vibration.rms 포인트 확보 권고).',
  });

  const ambient = medianShift(values(result.reference, 'ambient_c'), values(result.recent, 'ambient_c'));
  const cooling = levelCheck('cooling', '냉각 부족 (외기 온도 편중)', ambient?.shift ?? null, [p.ambientShiftC, 2], { ref_c: r(ambient?.ref ?? null, 2), recent_c: r(ambient?.cur ?? null, 2), shift_c: r(ambient?.shift ?? null, 2) }, {
    supports: '최근 운전이 더 더운 조건에 몰려 있습니다. 같은 외기 bin으로 비교했지만 인터쿨러·애프터쿨러 냉각 부족 영향이 남을 수 있습니다.',
    refutes: '외기 온도 분포는 비슷합니다.',
    unknown: '최근 외기 온도가 조금 높습니다.',
    no_data: '외기 온도 데이터가 없습니다.',
  });
  return [dischargeTemp, leak, vibration, cooling];
}

function buildFinding(input: CompSecRiseInput, p: CompSecRiseParams, result: RiseResult): CandidateFinding | null {
  if (result.severity === null) return null;
  const byStart = new Map(input.episodes.map((e) => [e.start, e]));
  const checks = checksOf(result, byStart, p);
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const trendText = result.trend === null ? '' : ` 누적 운전시간 추세 ${signed(result.trend.slope, 2)}%/1000 h.`;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity: result.severity,
    confidence: scoreConfidence({ n: result.matched.nCur, ciWidth: relativeCiWidth(result.risePct, result.ciLowPct, result.ciHighPct), dqCompleteness: median(result.recent.map((s) => s.completeness)), methodsAgree: trendAgrees(result.trend) }),
    title: `압축기 비에너지 ${fixed(result.risePct, 1)}% 상승`,
    summary:
      `같은 압력비·외기 온도 조건 운전 ${result.matched.nCur}회 비교: 비에너지 ${fixed(result.baselineLevel, 3)} kWh/kg → ${fixed(result.currentLevel, 3)} kWh/kg(${signed(result.risePct, 1)}%, 95% CI ${signed(result.ciLowPct, 1)} ~ ${signed(result.ciHighPct, 1)}%).${trendText}` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'comp_sec_kwh_per_kg', value: r(result.risePct, 3) ?? 0, unit: '%', ciLow: r(result.ciLowPct, 3), ciHigh: r(result.ciHighPct, 3), baseline: r(result.baselineLevel, 4), current: r(result.currentLevel, 4), levelUnit: 'kWh/kg' },
    ...riseWindow(result),
    evidence: { ...riseEvidence(result, 4), metric: 'comp_sec_kwh_per_kg', bin_widths: { pressure_ratio: p.ratioBinWidth, ambient_c: p.tempBinWidthC }, suction_temp_proxy: 'ambient.temp', checks },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, reference: result.reference.map((s) => [s.start, s.value, s.bin]), recent: result.recent.map((s) => [s.start, s.value, s.bin]) }),
  };
}

function detect(input: CompSecRiseInput, ctx: DetectorContext<CompSecRiseParams>): DetectorResult {
  const p = withDefaults(COMP_SEC_RISE_DEFAULTS, ctx.params);
  const samples = samplesOf(input, ctx, p);
  if (samples.length === 0) return insufficient(`비에너지를 계산할 압축기 운전이 없습니다 (이송량 ${fixed(p.minMassKg, 1)} kg 이상·압력비 필요)`);
  const outcome = compareRise(samples, ctx, p, { key: 'op_h', scale: 1000, unit: '%/1000 h' });
  if (!outcome.ok) return insufficient(`압축기 비에너지 ${outcome.reason}`);
  const finding = buildFinding(input, p, outcome.result);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const compSecRise: Detector<CompSecRiseInput, CompSecRiseParams> = {
  ...META,
  requires: {
    assetClass: ['h2.compressor'],
    metrics: [
      required('compressor.power', SLOW_S), // 운전 구간 전력량 적산 (이송 질량 5 kg 이상 = 30분 이상 구간만 쓴다)
      required('compressor.suction.pressure', SLOW_S), // 압력비 bin. 흡입 압력은 전해조 출구 압력이라 분 단위로 계단 변화한다
      required('compressor.discharge.pressure', SLOW_S), // 압력비 bin (뱅크 충전 중 서서히 오른다)
      required('h2.flow.mass', SLOW_S), // 이송 질량 적산 (전해조 제품 유량)
      required('ambient.temp', SLOW_S), // 흡입 가스 온도 대용 조건 bin — 외기는 시간 단위로 변한다
      recommended('compressor.discharge.temp', SLOW_S), // 판별 체크 ① 토출 온도 상승
      recommended('compressor.leak.pressure', SLOW_S), // 판별 체크 ② 누설 감지 압력 상승
      recommended('vibration.rms', SLOW_S), // 판별 체크 ③ 진동 증가
      recommended('run.hours', SLOW_S), // 누적 운전시간 축 추세 (없으면 같은 조건 비교만 한다)
    ],
    minHistoryDays: 45,
  },
  defaultParams: COMP_SEC_RISE_DEFAULTS,
  paramSchema: COMP_SEC_RISE_PARAM_SCHEMA,
  detect,
};
