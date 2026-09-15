// ess.cell_imbalance@1 — 충전 종료(또는 휴지) 셀 전압 편차(max−min)의 기준 대비 증가 + 2개월 증가 추세 + 동종 랙 대비 수정 z.
import type { EssChargeEpisode, EssRestEpisode } from '../episodes/ess';
import { downsample } from '../episodes/series';
import * as z from 'zod';
import { hashInput } from '../hash';
import { bootstrapTwoSampleCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median, modifiedZ } from '../stats/robust';
import { trendValueAt } from '../stats/trend';
import { DAYS_PER_MONTH, MS_PER_DAY } from '../types';
import { dailyMedians, fixed, insufficient, r, signed, summarizeTrend, withDefaults } from './common';
import { choiceParam, completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, Severity } from './types';

export type CellDvSource = 'charge_end' | 'rest';

export interface CellDvPoint {
  readonly ts: number;
  readonly dvMv: number;
  readonly source: CellDvSource;
  readonly completeness: number;
}

export interface EssCellImbalanceInput {
  readonly assetId: number;
  readonly points: readonly CellDvPoint[];
  /** 같은 동종 그룹 다른 랙들의 최근 편차 중앙값 [mV] */
  readonly peers: readonly { readonly assetId: number; readonly recentDvMv: number }[];
}

export interface EssCellImbalanceParams {
  readonly source: CellDvSource;
  readonly referenceSessions: number;
  readonly minReference: number;
  readonly recentDays: number;
  readonly minRecent: number;
  readonly trendDays: number;
  readonly minTrendDays: number;
  readonly deltaMv: number;
  readonly deltaMvSev3: number;
  readonly peerZ: number;
  readonly minPeers: number;
  readonly madFloorMv: number;
  readonly iterations: number;
  readonly minCompleteness: number;
}

export const ESS_CELL_IMBALANCE_DEFAULTS: EssCellImbalanceParams = Object.freeze({
  source: 'charge_end',
  referenceSessions: 20,
  minReference: 5,
  recentDays: 30,
  minRecent: 5,
  trendDays: 60,
  minTrendDays: 10,
  deltaMv: 20,
  deltaMvSev3: 40,
  peerZ: 3.5,
  minPeers: 2,
  madFloorMv: 2,
  iterations: 1000,
  minCompleteness: 0.9,
});

const D = ESS_CELL_IMBALANCE_DEFAULTS;
export const ESS_CELL_IMBALANCE_PARAM_SCHEMA = z.object({
  source: choiceParam(['charge_end', 'rest'] as const, D.source, { label: '편차 측정 시점', description: '충전 종료(charge_end) 또는 휴지(rest) 셀 전압 편차를 씁니다.' }),
  referenceSessions: intParam(D.referenceSessions, { label: '기준 세션 수', unit: '회', min: 3, max: 200, description: '기준 창이 없을 때 가장 이른 이 수만큼의 세션을 기준으로 씁니다.' }),
  minReference: intParam(D.minReference, { label: '최소 기준 세션', unit: '회', min: 2, max: 100, description: '기준 세션이 이보다 적으면 판정 불능입니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 7, max: 180, description: '최근 편차를 모으는 기간입니다.' }),
  minRecent: intParam(D.minRecent, { label: '최소 최근 세션', unit: '회', min: 2, max: 100, description: '최근 세션이 이보다 적으면 판정 불능입니다.' }),
  trendDays: intParam(D.trendDays, { label: '추세 기간', unit: '일', min: 14, max: 365, description: '증가 추세(Theil–Sen)를 보는 기간입니다.' }),
  minTrendDays: intParam(D.minTrendDays, { label: '추세 최소 일수', unit: '일', min: 3, max: 180, description: '추세를 계산하려면 필요한 일 중앙값 개수입니다.' }),
  deltaMv: numParam(D.deltaMv, { label: '편차 증가 기준', unit: 'mV', min: 1, max: 200, description: '기준 대비 편차 증가가 이 값 이상이고 증가 추세면 finding입니다.' }),
  deltaMvSev3: numParam(D.deltaMvSev3, { label: 'severity 3 편차 증가', unit: 'mV', min: 1, max: 500, description: '편차 증가가 이 값 이상이면 severity 3입니다.' }),
  peerZ: numParam(D.peerZ, { label: '동종 수정 z 기준', unit: '', min: 1, max: 10, description: '동종 랙 대비 수정 z가 이 값을 넘으면 severity 3입니다.' }),
  minPeers: intParam(D.minPeers, { label: '최소 동종 랙 수', unit: '대', min: 1, max: 50, description: '동종 비교에 필요한 다른 랙 수입니다.' }),
  madFloorMv: numParam(D.madFloorMv, { label: 'MAD 하한', unit: 'mV', min: 0, max: 50, description: '동종 편차가 거의 같을 때 작은 차이가 큰 z가 되지 않게 하는 하한입니다.' }),
  iterations: iterationsParam(D.iterations),
  minCompleteness: completenessParam(D.minCompleteness),
});

const META = { id: 'ess.cell_imbalance', version: '1', failureMode: 'ess.cell_imbalance', category: 'degradation' } as const;

/** ess.charge·ess.rest 에피소드 → 편차 점 (유효하고 cell_dv_end가 있는 것만) */
export function cellDvPoints(charges: readonly EssChargeEpisode[], rests: readonly EssRestEpisode[]): CellDvPoint[] {
  const fromCharges = charges.flatMap((e) => (e.valid && e.features.cell_dv_end !== null ? [{ ts: e.end, dvMv: e.features.cell_dv_end, source: 'charge_end' as const, completeness: e.dq.completeness }] : []));
  const fromRests = rests.flatMap((e) => (e.valid && e.features.cell_dv_end !== null ? [{ ts: e.end, dvMv: e.features.cell_dv_end, source: 'rest' as const, completeness: e.dq.completeness }] : []));
  return [...fromCharges, ...fromRests].sort((a, b) => a.ts - b.ts);
}

function peerZ(selfMv: number, peers: EssCellImbalanceInput['peers'], p: EssCellImbalanceParams): number | null {
  if (peers.length < p.minPeers) return null;
  return modifiedZ([selfMv, ...peers.map((peer) => peer.recentDvMv)], { madFloor: p.madFloorMv })[0] ?? null;
}

function detect(input: EssCellImbalanceInput, ctx: DetectorContext<EssCellImbalanceParams>): DetectorResult {
  const p = withDefaults(ESS_CELL_IMBALANCE_DEFAULTS, ctx.params);
  const from = ctx.baselineResetAt ?? -Infinity;
  const points = input.points.filter((pt) => pt.source === p.source && pt.ts >= from && pt.ts <= ctx.now && pt.completeness >= p.minCompleteness).sort((a, b) => a.ts - b.ts);
  const window = ctx.referenceWindow;
  const reference = window ? points.filter((pt) => pt.ts >= window.start && pt.ts < window.end) : points.slice(0, p.referenceSessions);
  const referenceEnd = reference[reference.length - 1]?.ts ?? Infinity;
  const recent = points.filter((pt) => pt.ts > referenceEnd && pt.ts >= ctx.now - p.recentDays * MS_PER_DAY);
  if (reference.length < p.minReference || recent.length < p.minRecent) {
    return insufficient(`셀 전압 편차 세션 부족: 기준 ${reference.length}회·최근 ${recent.length}회 (각 ${p.minReference}·${p.minRecent}회 필요)`);
  }

  const refValues = reference.map((pt) => pt.dvMv);
  const curValues = recent.map((pt) => pt.dvMv);
  const delta = bootstrapTwoSampleCI(curValues, refValues, (a, b) => median(a) - median(b), { iterations: p.iterations, rng: ctx.rng });
  const daily = dailyMedians(points.filter((pt) => pt.ts >= ctx.now - p.trendDays * MS_PER_DAY).map((pt) => ({ ts: pt.ts, value: pt.dvMv })));
  const t0 = daily[0]?.ts ?? 0;
  const trend = daily.length >= p.minTrendDays ? summarizeTrend(daily.map((d) => (d.ts - t0) / MS_PER_DAY), daily.map((d) => d.value), { referenceCount: Math.ceil(daily.length / 3), sigmaFloor: p.madFloorMv, direction: 'up', k: 0.5, h: 5 }) : null;
  const increasing = trend !== null && trend.fit.ciLow > 0;
  const selfRecent = median(curValues);
  const z = peerZ(selfRecent, input.peers, p);
  if (!(delta.estimate >= p.deltaMv && increasing && trend)) return { status: 'ok', findings: [] };

  const severity: Severity = delta.estimate >= p.deltaMvSev3 || (z !== null && z > p.peerZ) ? 3 : 2;
  const slopeMonth = trend.fit.slope * DAYS_PER_MONTH;
  const peerText = z === null ? '' : ` 같은 동종 랙 ${input.peers.length}대 대비 수정 z ${fixed(z, 1)}.`;
  const finding: CandidateFinding = {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: recent.length, ciWidth: relativeCiWidth(delta.estimate, delta.ciLow, delta.ciHigh), dqCompleteness: median(recent.map((pt) => pt.completeness)), methodsAgree: trend.mkPValue < 0.05 }),
    title: `셀 전압 편차 ${fixed(delta.estimate, 0)} mV 증가`,
    summary: `${p.source === 'charge_end' ? '충전 종료' : '휴지'} 셀 전압 편차가 ${fixed(median(refValues), 1)} mV → ${fixed(selfRecent, 1)} mV로 ${fixed(delta.estimate, 1)} mV 커졌고(95% CI ${fixed(delta.ciLow, 1)} ~ ${fixed(delta.ciHigh, 1)} mV), 최근 ${p.trendDays}일 증가 추세(${signed(slopeMonth, 1)} mV/월)입니다.${peerText}`,
    effect: { metric: 'cell_dv_mv', value: r(delta.estimate, 2) ?? 0, unit: 'mV', ciLow: r(delta.ciLow, 2), ciHigh: r(delta.ciHigh, 2), baseline: r(median(refValues), 2), current: r(selfRecent, 2), levelUnit: 'mV' },
    windowStart: reference[0]?.ts ?? ctx.now,
    windowEnd: recent[recent.length - 1]?.ts ?? ctx.now,
    evidence: {
      method: 'median_shift_trend_peer',
      source: p.source,
      reference: { n: reference.length, median_mv: r(median(refValues), 2) },
      recent: { n: recent.length, median_mv: r(selfRecent, 2) },
      trend: {
        slope_mv_per_month: r(slopeMonth, 3),
        ci_low_mv_per_month: r(trend.fit.ciLow * DAYS_PER_MONTH, 3),
        ci_high_mv_per_month: r(trend.fit.ciHigh * DAYS_PER_MONTH, 3),
        mann_kendall_p: r(trend.mkPValue, 4),
        change_start: trend.changeStartIndex === null ? null : (daily[trend.changeStartIndex]?.ts ?? null),
        points: downsample(daily, 120).map((d) => ({ t: d.ts, dv_mv: r(d.value, 2) })),
        line: [0, (daily[daily.length - 1]?.ts ?? t0) - t0].map((dx) => ({ t: t0 + dx, dv_mv: r(trendValueAt(trend.fit, dx / MS_PER_DAY), 3) })),
      },
      peers: { n: input.peers.length, modified_z: r(z, 2), values_mv: input.peers.map((peer) => ({ asset_id: peer.assetId, dv_mv: r(peer.recentDvMv, 2) })) },
    },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, points: points.map((pt) => [pt.ts, pt.dvMv]), peers: input.peers }),
  };
  return { status: 'ok', findings: [finding] };
}

export const essCellImbalance: Detector<EssCellImbalanceInput, EssCellImbalanceParams> = {
  ...META,
  requires: { assetClass: ['ess.rack'], metrics: ['batt.current', 'cell.voltage.max', 'cell.voltage.min'], minPeriodS: 60, minHistoryDays: 60 },
  defaultParams: ESS_CELL_IMBALANCE_DEFAULTS,
  paramSchema: ESS_CELL_IMBALANCE_PARAM_SCHEMA,
  detect,
};
