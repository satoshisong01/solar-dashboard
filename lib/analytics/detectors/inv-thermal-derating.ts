// inv.thermal_derating@1 — 인버터 열 출력저감.
// 버킷(기본 5분)마다 동종 인버터 kW/kWp 중앙값과 비교해, 이 인버터가 derateGapPct 이상 낮고 방열판 온도 ≥ 저감 시작 온도 − marginC이며
// 출력제한(ac.power.limit < 99.5%)이 아니면 저감 버킷 → 일별 저감 시간·손실 kWh. 최근 recentDays일 손실률(손실 ÷ (발전 + 손실)) ≥ sev2LossPct면 finding.
// 손실률이 그 미만이어도 동종 대비 저감이 sustainedDerateHours 이상 반복되면(냉각팬 고장은 더운 날에만 저감이 보여 월 손실률이 작다) severity 2 finding.
// 외기온도 bin별 일 저감 시간 기준 vs 최근 비교(같은 외기에서 저감 시간이 늘면 냉각팬·필터·방열판 오염)를 근거·신뢰도에 쓴다.
// 판별 체크: ① 외기 고온 편중 ② 냉각팬 고장 코드(event_log) ③ 설치 환경(동종 전체가 함께 고온 → 설치실 환기) ④ 출력제한 혼동 배제.
// severity: 손실 1% → 2, 3% → 3 (성능 카테고리, 3 상한).
import * as z from 'zod';
import type { InverterThermalSample } from '../episodes/inverter-thermal';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import { kstDayStart, MS_PER_DAY } from '../types';
import { fixed, insufficient, r, withDefaults } from './common';
import { dayRowsOf, derateEvidence, derateSamples, thermalChecks, type DayRow, type DerateSample } from './inv-thermal-samples';
import { intParam, iterationsParam, numParam } from './param-schema';
import { required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, Severity } from './types';

export interface ThermalInverter {
  readonly assetId: number;
  readonly dcKwp: number;
  /** 명판 저감 시작 방열판 온도 [°C]. 없으면 params.defaultDerateStartC */
  readonly derateStartC: number | null;
}

export interface InverterFaultEvent {
  readonly assetId: number;
  readonly ts: number;
  readonly code: string;
}

export interface InvThermalDeratingInput {
  readonly siteId: number;
  readonly inverters: readonly ThermalInverter[];
  readonly samples: readonly InverterThermalSample[];
  /** event_log 고장·경보 코드. 없으면 냉각팬 체크는 데이터없음 */
  readonly faultEvents?: readonly InverterFaultEvent[];
}

export interface InvThermalDeratingParams {
  readonly recentDays: number;
  readonly derateGapPct: number;
  readonly marginC: number;
  readonly defaultDerateStartC: number;
  readonly minPeers: number;
  readonly minPeerKwPerKwp: number;
  readonly minDerateHours: number;
  readonly minDerateDays: number;
  readonly sustainedDerateHours: number;
  readonly sev2LossPct: number;
  readonly sev3LossPct: number;
  readonly ambientBinWidthC: number;
  readonly referencePerBin: number;
  readonly hotAmbientC: number;
  readonly ambientShiftC: number;
  readonly allPeersHotShare: number;
  readonly iterations: number;
}

export const INV_THERMAL_DERATING_DEFAULTS: InvThermalDeratingParams = Object.freeze({
  recentDays: 30,
  derateGapPct: 5,
  marginC: 5,
  defaultDerateStartC: 70,
  minPeers: 3,
  minPeerKwPerKwp: 0.3,
  minDerateHours: 3,
  minDerateDays: 3,
  sustainedDerateHours: 6,
  sev2LossPct: 1,
  sev3LossPct: 3,
  ambientBinWidthC: 5,
  referencePerBin: 5,
  hotAmbientC: 35,
  ambientShiftC: 5,
  allPeersHotShare: 0.75,
  iterations: 1000,
});

const D = INV_THERMAL_DERATING_DEFAULTS;
export const INV_THERMAL_DERATING_PARAM_SCHEMA = z.object({
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 7, max: 120, description: '저감 손실률을 합산하는 최근 일수입니다.' }),
  derateGapPct: numParam(D.derateGapPct, { label: '동종 대비 출력 차이 기준', unit: '%', min: 0.5, max: 50, description: '같은 시각 동종 kW/kWp 중앙값보다 이 비율 이상 낮으면 저감 후보입니다.' }),
  marginC: numParam(D.marginC, { label: '저감 시작 온도 여유', unit: '°C', min: 0, max: 30, description: '방열판 온도가 (저감 시작 온도 − 이 값) 이상일 때만 열 저감으로 봅니다.' }),
  defaultDerateStartC: numParam(D.defaultDerateStartC, { label: '기본 저감 시작 온도', unit: '°C', min: 40, max: 110, description: '명판에 저감 시작 방열판 온도가 없을 때 씁니다 (제조사별 70~80 °C 부근).' }),
  minPeers: intParam(D.minPeers, { label: '최소 동종 인버터 수', unit: '대', min: 3, max: 100, description: '출력제한이 아닌 인버터가 이보다 적은 시각은 비교하지 않습니다.' }),
  minPeerKwPerKwp: numParam(D.minPeerKwPerKwp, { label: '비교 최소 출력', unit: 'kW/kWp', min: 0.05, max: 1.2, description: '동종 중앙값이 이보다 낮은 시각(저출력)은 비교하지 않습니다.' }),
  minDerateHours: numParam(D.minDerateHours, { label: '최소 저감 시간', unit: 'h', min: 0.1, max: 500, description: '최근 기간 저감 시간 합계가 이보다 적으면 finding을 내지 않습니다.' }),
  minDerateDays: intParam(D.minDerateDays, { label: '최소 저감 일수', unit: '일', min: 1, max: 60, description: '저감이 있었던 날이 이보다 적으면 finding을 내지 않습니다.' }),
  sustainedDerateHours: numParam(D.sustainedDerateHours, { label: '반복 저감 시간', unit: 'h', min: 0.5, max: 500, description: '손실률이 severity 2 기준 미만이어도 최근 기간 동종 대비 저감 시간이 이 값 이상이면 finding(severity 2)입니다 (냉각 계통 점검 권고).' }),
  sev2LossPct: numParam(D.sev2LossPct, { label: 'severity 2 손실률', unit: '%', min: 0.1, max: 50, description: '최근 기간 저감 손실 ÷ (발전 + 손실)이 이 값 이상이면 finding(severity 2)입니다.' }),
  sev3LossPct: numParam(D.sev3LossPct, { label: 'severity 3 손실률', unit: '%', min: 0.1, max: 50, description: '이 값 이상이면 severity 3입니다 (성능 카테고리라 3이 상한).' }),
  ambientBinWidthC: numParam(D.ambientBinWidthC, { label: '외기 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '일 최고 외기 온도로 나누는 구간 폭입니다 (같은 외기에서 저감 시간 비교).' }),
  referencePerBin: intParam(D.referencePerBin, { label: 'bin별 기준 일수', unit: '일', min: 1, max: 60, description: '외기 bin마다 최근 기간 이전 가장 이른 이 일수를 기준으로 씁니다.' }),
  hotAmbientC: numParam(D.hotAmbientC, { label: '고온 외기 기준', unit: '°C', min: 20, max: 50, description: '저감 시간 대부분이 이 외기 온도 미만에서 났으면 외기 탓이 아니라고 봅니다.' }),
  ambientShiftC: numParam(D.ambientShiftC, { label: '외기 고온 편중 기준', unit: '°C', min: 0.5, max: 30, description: '최근 일 최고 외기 온도 중앙값이 기준보다 이만큼 높으면 외기 고온 편중을 지지로 봅니다.' }),
  allPeersHotShare: numParam(D.allPeersHotShare, { label: '동종 동시 고온 비율', unit: '', min: 0.1, max: 1, description: '고온 시각에 이 비율 이상의 동종도 함께 고온이면 설치 환경(설치실 환기) 문제로 봅니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'inv.thermal_derating', version: '1', failureMode: 'pv.inverter_thermal_derating', category: 'performance' } as const;

const lossPctOf = (rows: readonly DayRow[]): number => {
  const loss = rows.reduce((sum, row) => sum + row.lossKwh, 0);
  const energy = rows.reduce((sum, row) => sum + row.energyKwh, 0);
  return loss + energy > 0 ? (loss / (loss + energy)) * 100 : 0;
};

function findingFor(inverter: ThermalInverter, input: InvThermalDeratingInput, samples: readonly DerateSample[], ctx: DetectorContext<InvThermalDeratingParams>, p: InvThermalDeratingParams): CandidateFinding | null {
  const rows = dayRowsOf(samples.filter((s) => s.assetId === inverter.assetId));
  const recentFrom = kstDayStart(ctx.now) - p.recentDays * MS_PER_DAY;
  const recent = rows.filter((row) => row.day >= recentFrom);
  const reference = rows.filter((row) => row.day < recentFrom);
  const lossPct = lossPctOf(recent);
  const derateHours = recent.reduce((sum, row) => sum + row.derateHours, 0);
  const derateDays = recent.filter((row) => row.derateHours > 0).length;
  const sustained = derateHours >= p.sustainedDerateHours;
  if (recent.length === 0 || !(lossPct >= p.sev2LossPct || sustained) || derateHours < p.minDerateHours || derateDays < p.minDerateDays) return null;

  const ci = bootstrapCI(recent, lossPctOf, { iterations: p.iterations, rng: ctx.rng });
  const severity: Severity = lossPct >= p.sev3LossPct ? 3 : 2;
  const evidence = derateEvidence({ inverter, recent, reference, samples, p });
  const checks = thermalChecks({ inverter, recent, reference, samples: samples.filter((s) => s.ts >= recentFrom), input, p });
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const lossKwh = recent.reduce((sum, row) => sum + row.lossKwh, 0);
  const binText = evidence.binShift === null ? '' : ` 같은 외기 조건에서 일 저감 시간 ${fixed(evidence.binShift.ref, 1)} h → ${fixed(evidence.binShift.cur, 1)} h.`;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: inverter.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: recent.length, ciWidth: relativeCiWidth(lossPct, ci.ciLow, ci.ciHigh), dqCompleteness: median(recent.map((row) => row.coverage)), methodsAgree: evidence.binShift === null ? null : evidence.binShift.cur > evidence.binShift.ref }),
    title: `인버터 열 출력저감 손실 ${fixed(lossPct, 1)}% (최근 ${p.recentDays}일 저감 ${fixed(derateHours, 1)}시간)`,
    summary:
      `최근 ${p.recentDays}일 중 ${derateDays}일, 방열판 온도가 저감 시작 온도 부근일 때 동종 대비 출력이 ${fixed(p.derateGapPct, 0)}% 이상 낮은 시간이 ${fixed(derateHours, 1)}시간이었습니다. ` +
      `손실 약 ${fixed(lossKwh, 0)} kWh(발전량 대비 ${fixed(lossPct, 2)}%, 95% CI ${fixed(ci.ciLow, 2)} ~ ${fixed(ci.ciHigh, 2)}%). 출력제한 시각은 뺐습니다.${binText}` +
      (lossPct < p.sev2LossPct ? ` 손실률은 ${fixed(p.sev2LossPct, 1)}% 미만이지만 동종 대비 저감이 반복되어 냉각팬·필터·방열판 점검을 권고합니다.` : '') +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'thermal_derate_loss_pct', value: r(lossPct, 3) ?? 0, unit: '%', ciLow: r(ci.ciLow, 3), ciHigh: r(ci.ciHigh, 3), baseline: reference.length === 0 ? null : r(lossPctOf(reference), 3), current: r(lossPct, 3), levelUnit: '%' },
    windowStart: rows[0]?.day ?? recentFrom,
    windowEnd: (recent.at(-1)?.day ?? recentFrom) + MS_PER_DAY,
    evidence: { ...evidence.json, checks },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, inverter, rows: rows.map((row) => [row.day, row.derateHours, row.lossKwh, row.energyKwh]) }),
  };
}

function detect(input: InvThermalDeratingInput, ctx: DetectorContext<InvThermalDeratingParams>): DetectorResult {
  const p = withDefaults(INV_THERMAL_DERATING_DEFAULTS, ctx.params);
  const from = ctx.baselineResetAt ?? -Infinity;
  const samples = derateSamples(input.samples.filter((s) => s.ts >= from && s.ts < ctx.now), input.inverters, p);
  if (samples.length === 0) return insufficient(`동종 ${p.minPeers}대 이상을 같은 시각에 비교할 수 있는 고출력 구간이 없습니다 (동종 중앙값 ${fixed(p.minPeerKwPerKwp, 2)} kW/kWp 이상)`);
  const findings = [...input.inverters].sort((a, b) => a.assetId - b.assetId).flatMap((inverter) => findingFor(inverter, input, samples, ctx, p) ?? []);
  return { status: 'ok', findings };
}

export const invThermalDerating: Detector<InvThermalDeratingInput, InvThermalDeratingParams> = {
  ...META,
  requires: {
    assetClass: ['pv.inverter', 'wx.station'],
    metrics: [
      required('ac.power', SLOW_S), // 저감 구간 출력. 저감은 시간 단위로 이어져 5분 표본으로 형태가 보인다
      required('heatsink.temp', SLOW_S), // 방열판 온도. 열시상수가 분 단위라 5분이면 상승 곡선을 잡는다
      required('ac.power.limit', SLOW_S), // 출력제어에 의한 감소를 열 저감과 구분한다
      required('ambient.temp', SLOW_S), // 같은 외기 온도에서 비교 (사이트 기상 설비)
    ],
    minHistoryDays: 30,
  },
  defaultParams: INV_THERMAL_DERATING_DEFAULTS,
  paramSchema: INV_THERMAL_DERATING_PARAM_SCHEMA,
  detect,
};
