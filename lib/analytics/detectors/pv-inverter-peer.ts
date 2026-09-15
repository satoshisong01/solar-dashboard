// pv.inverter_peer@1 — 같은 사이트 인버터들의 일 kWh/kWp를 동종 중앙값과 비교 (기상 영향을 사이트 내 동종 비교로 제거, 설계 §5.3).
// 수정 z < −3.5가 최근 7일 중 5일 이상이면 finding. 출력제한·클리핑·정지일·완결성 미달일은 제외, 동종 3대 이상인 날만 평가.
import type { PvDayEpisode } from '../episodes/pv';
import * as z from 'zod';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median, modifiedZ } from '../stats/robust';
import { kstDateString, kstDayStart, MS_PER_DAY } from '../types';
import { fixed, insufficient, r, signed, withDefaults } from './common';
import { completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, Severity } from './types';

export interface PvInverterPeerInput {
  readonly siteId: number;
  /** 사이트 모든 인버터의 pv.day 에피소드 */
  readonly days: readonly PvDayEpisode[];
}

export interface PvInverterPeerParams {
  readonly recentDays: number;
  readonly minFlaggedDays: number;
  readonly minPeers: number;
  readonly zThreshold: number;
  /** MAD 하한 = 동종 중앙값 × 이 비율 */
  readonly madFloorRatio: number;
  readonly minCompleteness: number;
  readonly sev3Pct: number;
  readonly iterations: number;
}

export const PV_INVERTER_PEER_DEFAULTS: PvInverterPeerParams = Object.freeze({
  recentDays: 7,
  minFlaggedDays: 5,
  minPeers: 3,
  zThreshold: -3.5,
  // sim:eval: 0.5% → 0.3% (유효 탐지 편차 약 2.6% → 1.6%, 인버터 2%p 저하 0/3 → 3/3, 대조군 포함 오탐 0). 수정 z 임계 −3.5·5/7일 조건은 그대로
  madFloorRatio: 0.003,
  minCompleteness: 0.9,
  sev3Pct: -10,
  iterations: 1000,
});

const D = PV_INVERTER_PEER_DEFAULTS;
export const PV_INVERTER_PEER_PARAM_SCHEMA = z.object({
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 3, max: 60, description: '동종 비교를 하는 최근 일수입니다.' }),
  minFlaggedDays: intParam(D.minFlaggedDays, { label: '최소 저하 일수', unit: '일', min: 1, max: 60, description: '최근 기간 중 동종 대비 낮은 날이 이 수 이상이면 finding입니다.' }),
  minPeers: intParam(D.minPeers, { label: '최소 동종 인버터 수', unit: '대', min: 3, max: 100, description: '그날 비교할 수 있는 인버터가 이보다 적으면 그날은 평가하지 않습니다.' }),
  zThreshold: numParam(D.zThreshold, { label: '수정 z 기준', unit: '', min: -10, max: -1, description: '동종 중앙값 대비 수정 z가 이 값보다 작으면 저하일로 봅니다.' }),
  madFloorRatio: numParam(D.madFloorRatio, { label: 'MAD 하한 비율', unit: '', min: 0, max: 0.1, description: 'MAD 하한 = 동종 중앙값 × 이 비율. 동종이 거의 같을 때 과민 반응을 막습니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  sev3Pct: numParam(D.sev3Pct, { label: 'severity 3 편차', unit: '%', min: -100, max: 0, description: '동종 대비 편차 중앙값이 이 값 이하이면 severity 3입니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'pv.inverter_peer', version: '1', failureMode: 'pv.inverter_underperformance', category: 'performance' } as const;

interface DayScore {
  readonly day: number;
  readonly assetId: number;
  readonly kwhPerKwp: number;
  readonly peerMedian: number;
  readonly z: number;
  readonly deviationPct: number;
  readonly peers: number;
  readonly completeness: number;
}

const excluded = (d: PvDayEpisode, p: PvInverterPeerParams): boolean =>
  !d.valid || d.conditions.curtailed || d.conditions.clipping || d.conditions.stopped || d.dq.completeness < p.minCompleteness;

function scoreDays(days: readonly PvDayEpisode[], p: PvInverterPeerParams): DayScore[] {
  const byDay = new Map<number, PvDayEpisode[]>();
  for (const d of days) byDay.set(d.start, [...(byDay.get(d.start) ?? []), d]);
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([day, all]) => {
      const eligible = all.filter((d) => !excluded(d, p));
      if (eligible.length < p.minPeers) return [];
      const values = eligible.map((d) => d.features.kwh_per_kwp);
      const center = median(values);
      if (!(center > 0)) return [];
      const zs = modifiedZ(values, { madFloor: p.madFloorRatio * center });
      return eligible.map((d, i) => ({
        day,
        assetId: d.assetId,
        kwhPerKwp: d.features.kwh_per_kwp,
        peerMedian: center,
        z: zs[i] ?? 0,
        deviationPct: (d.features.kwh_per_kwp / center - 1) * 100,
        peers: eligible.length,
        completeness: d.dq.completeness,
      }));
    });
}

function findingFor(assetId: number, scores: readonly DayScore[], ctx: DetectorContext<PvInverterPeerParams>, p: PvInverterPeerParams, input: PvInverterPeerInput): CandidateFinding | null {
  const own = scores.filter((s) => s.assetId === assetId);
  const flagged = own.filter((s) => s.z < p.zThreshold);
  if (flagged.length < p.minFlaggedDays) return null;
  const deviations = flagged.map((s) => s.deviationPct);
  const effect = bootstrapCI(deviations, median, { iterations: p.iterations, rng: ctx.rng });
  const severity: Severity = effect.estimate <= p.sev3Pct ? 3 : 2;
  const excludedDays = input.days.filter((d) => d.assetId === assetId && d.start >= kstDayStart(ctx.now) - p.recentDays * MS_PER_DAY && d.end <= ctx.now && excluded(d, p)).length;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: flagged.length, ciWidth: relativeCiWidth(effect.estimate, effect.ciLow, effect.ciHigh), dqCompleteness: median(flagged.map((s) => s.completeness)), methodsAgree: flagged.length / own.length >= 0.8 }),
    title: `인버터 발전량 동종 대비 ${fixed(Math.abs(effect.estimate), 1)}% 낮음`,
    summary: `최근 ${p.recentDays}일 중 ${flagged.length}일 같은 사이트 동종 인버터 대비 kWh/kWp가 낮았습니다(중앙값 ${signed(effect.estimate, 1)}%, 95% CI ${signed(effect.ciLow, 1)} ~ ${signed(effect.ciHigh, 1)}%, 수정 z < ${fixed(p.zThreshold, 1)}). 출력제한·클리핑·정지일 ${excludedDays}일은 제외했습니다.`,
    effect: {
      metric: 'kwh_per_kwp_vs_peer',
      value: r(effect.estimate, 3) ?? 0,
      unit: '%',
      ciLow: r(effect.ciLow, 3),
      ciHigh: r(effect.ciHigh, 3),
      baseline: r(median(flagged.map((s) => s.peerMedian)), 4),
      current: r(median(flagged.map((s) => s.kwhPerKwp)), 4),
      levelUnit: 'kWh/kWp',
    },
    windowStart: own[0]?.day ?? ctx.now,
    windowEnd: (own[own.length - 1]?.day ?? ctx.now) + MS_PER_DAY,
    evidence: {
      method: 'peer_modified_z',
      site_id: input.siteId,
      days: own.map((s) => ({ day: kstDateString(s.day), kwh_per_kwp: r(s.kwhPerKwp, 4), peer_median: r(s.peerMedian, 4), deviation_pct: r(s.deviationPct, 2), modified_z: r(s.z, 2), peers: s.peers, flagged: s.z < p.zThreshold })),
      excluded_days: excludedDays,
    },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, scores: scores.map((s) => [s.day, s.assetId, s.kwhPerKwp]) }),
  };
}

function detect(input: PvInverterPeerInput, ctx: DetectorContext<PvInverterPeerParams>): DetectorResult {
  const p = withDefaults(PV_INVERTER_PEER_DEFAULTS, ctx.params);
  const from = kstDayStart(ctx.now) - p.recentDays * MS_PER_DAY;
  const recentDays = input.days.filter((d) => d.start >= from && d.end <= ctx.now && d.start >= (ctx.baselineResetAt ?? -Infinity));
  const scores = scoreDays(recentDays, p);
  if (scores.length === 0) return insufficient(`최근 ${p.recentDays}일 중 동종 ${p.minPeers}대 이상을 비교할 수 있는 날이 없습니다`);
  const assetIds = [...new Set(scores.map((s) => s.assetId))].sort((a, b) => a - b);
  const findings = assetIds.flatMap((assetId) => {
    const finding = findingFor(assetId, scores, ctx, p, input);
    return finding ? [finding] : [];
  });
  return { status: 'ok', findings };
}

export const pvInverterPeer: Detector<PvInverterPeerInput, PvInverterPeerParams> = {
  ...META,
  requires: { assetClass: ['pv.inverter'], metrics: ['ac.power', 'ac.power.limit', 'op.state'], minPeriodS: 300, minHistoryDays: 7 },
  defaultParams: PV_INVERTER_PEER_DEFAULTS,
  paramSchema: PV_INVERTER_PEER_PARAM_SCHEMA,
  detect,
};
