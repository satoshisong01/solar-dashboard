// 근거 스냅샷(jsonb) → 표시 모델. 탐지기별 스냅샷 형식은 lib/analytics/detectors/*의 evidence 필드를 따른다. 순수 모듈.
// 예전 스냅샷에 없는 필드(bin 폭 등)는 현재 기본값으로 채운다.
import { ESS_CAPACITY_DEFAULTS } from '@/lib/analytics/detectors/ess-capacity-fade';
import { DEFAULT_ESS_EXTRACTOR_PARAMS } from '@/lib/analytics/episodes/ess';
import { DEFAULT_STACK_EXTRACTOR_PARAMS } from '@/lib/analytics/episodes/stack-episodes';
import { DAYS_PER_MONTH, MS_PER_DAY } from '@/lib/analytics/types';
import { CAPACITY_METRICS, parseCapacityBinKey, type CapacityMetric } from './conditions';
import { formatSigned } from './effect';
import type { CapacityEvidence, CellImbalanceEvidence, DqEvidence, EvidenceView, PvPeerEvidence, Span, StackEvidence } from './evidence-types';
import { asArray, asBoolean, asNumber, asRecord, asString, xyPoints, type JsonRecord } from './json-read';
import { parseChecks } from './evidence-checks';
import { parseP3Evidence } from './p3-evidence';
import { projectionOf } from './projection';
import type { ChargeCurve } from './overlay';
import type { TrendView } from './trend';

const MS_PER_MONTH = DAYS_PER_MONTH * MS_PER_DAY;

export { parseChecks };

const slopeText = (slope: number | null, low: number | null, high: number | null, unit: string, digits: number): string | null =>
  slope === null ? null : `${formatSigned(slope, digits)} ${unit}${low === null || high === null ? '' : ` (95% CI ${formatSigned(low, digits)} ~ ${formatSigned(high, digits)})`}`;

function parseCurve(value: unknown): ChargeCurve | null {
  const c = asRecord(value);
  const start = asNumber(c.start);
  if (start === null) return null;
  const points = asArray(c.points).flatMap((item) => {
    const p = asRecord(item);
    const elapsedS = asNumber(p.elapsed_s);
    const ah = asNumber(p.ah);
    return elapsedS === null || ah === null ? [] : [{ elapsedS, ah, soc: asNumber(p.soc) }];
  });
  return points.length === 0 ? null : { start, capacityAh: asNumber(c.capacity_ah), points };
}

function capacityTrend(t: JsonRecord): TrendView | null {
  const points = xyPoints(t.points, 't', 'soh_pct');
  if (points.length === 0) return null;
  const perMonth = { slope: asNumber(t.slope_pct_per_month), low: asNumber(t.ci_low_pct_per_month), high: asNumber(t.ci_high_pct_per_month) };
  const perMs = (v: number | null) => (v === null ? null : v / MS_PER_MONTH);
  const line = xyPoints(t.line, 't', 'soh_pct');
  return {
    xKind: 'time',
    yName: '정격 대비 유효용량 (%)',
    points,
    line: line.length >= 2 ? line : null,
    slope: perMs(perMonth.slope),
    ciLow: perMs(perMonth.low),
    ciHigh: perMs(perMonth.high),
    slopeText: slopeText(perMonth.slope, perMonth.low, perMonth.high, '%p/월', 2),
    changeStart: asNumber(t.change_start),
  };
}

/** bin 표 순서: C-rate → 셀온도 오름차순 (값 없는 bin은 뒤로) */
function byCapacityBin(a: { readonly key: string }, b: { readonly key: string }): number {
  const pa = parseCapacityBinKey(a.key);
  const pb = parseCapacityBinKey(b.key);
  const cmp = (x: number | null, y: number | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y);
  return cmp(pa.cRate, pb.cRate) || cmp(pa.tempC, pb.tempC);
}

function parseCapacity(s: JsonRecord): CapacityEvidence {
  const metric = asString(s.metric);
  const widths = asRecord(s.bin_widths);
  const trend = asRecord(s.trend);
  const target = asRecord(trend.soh_target_date);
  const trendView = capacityTrend(trend);
  const projection = projectionOf({
    estimate: asNumber(target.estimate),
    early: asNumber(target.early),
    late: asNumber(target.late),
    slopeCiHigh: asNumber(trend.ci_high_pct_per_month),
    firstTs: trendView?.points[0]?.[0] ?? null,
    lastTs: trendView?.points.at(-1)?.[0] ?? null,
    minSpanDays: asNumber(trend.min_span_days_for_projection),
  });
  const window = (value: unknown) => ({ n: asNumber(asRecord(value).n) ?? 0, from: asNumber(asRecord(value).from), to: asNumber(asRecord(value).to) });
  const restRules = asRecord(s.rest_pair_rules);
  return {
    kind: 'capacity',
    metric: metric !== null && (CAPACITY_METRICS as readonly string[]).includes(metric) ? (metric as CapacityMetric) : 'capacity_ah_anchored',
    cautions: asArray(s.cautions).flatMap((c) => (typeof c === 'string' ? [c] : [])),
    widths: { cRate: asNumber(widths.c_rate) ?? ESS_CAPACITY_DEFAULTS.cRateBinWidth, tempC: asNumber(widths.temp_c) ?? ESS_CAPACITY_DEFAULTS.tempBinWidthC },
    rules: {
      anchorSocMaxPct: DEFAULT_ESS_EXTRACTOR_PARAMS.anchorSocMaxPct,
      minCcSocSpanPct: DEFAULT_ESS_EXTRACTOR_PARAMS.minCcSocSpanPct,
      minSocSpanPct: DEFAULT_ESS_EXTRACTOR_PARAMS.minSocSpanPct,
      restMinutes: asNumber(restRules.rest_minutes) ?? ESS_CAPACITY_DEFAULTS.restMinutes,
      minDeltaSocRestPct: asNumber(restRules.min_delta_soc_pct) ?? ESS_CAPACITY_DEFAULTS.minDeltaSocRest,
    },
    bins: asArray(s.bins)
      .flatMap((item) => {
        const b = asRecord(item);
        const key = asString(b.key);
        return key === null
          ? []
          : [{ key, nRef: asNumber(b.n_ref) ?? 0, nCur: asNumber(b.n_cur) ?? 0, medRef: asNumber(b.med_ref), medCur: asNumber(b.med_cur), ratio: asNumber(b.ratio), used: asBoolean(b.used) ?? false, refFrom: asNumber(b.ref_from), refTo: asNumber(b.ref_to), excluded: asString(b.excluded) }];
      })
      .sort(byCapacityBin),
    reference: window(s.reference),
    recent: window(s.recent),
    trend: trendView,
    sohTarget: asNumber(trend.soh_target_pct) === null ? null : { pct: asNumber(trend.soh_target_pct) ?? 80, estimate: asNumber(target.estimate), early: asNumber(target.early), late: asNumber(target.late), projection },
    referenceCurrentA: asNumber(asRecord(s.charge_time).reference_current_a),
    overlay: { reference: parseCurve(asRecord(s.overlay).reference), recent: parseCurve(asRecord(s.overlay).recent) },
    checks: parseChecks(s.checks),
  };
}

function stackBinLabel(key: string): string {
  const [j = 'na', t = 'na'] = key.split('|');
  const { jBinWidth, tempBinWidthC } = DEFAULT_STACK_EXTRACTOR_PARAMS;
  const range = (text: string, width: number, digits: number, unit: string) => (Number.isFinite(Number(text)) && text !== 'na' ? `${Number(text).toFixed(digits)}~${(Number(text) + width).toFixed(digits)} ${unit}` : null);
  const parts = [range(j, jBinWidth, 1, 'A/cm²'), range(t, tempBinWidthC, 0, '°C')].filter((p): p is string => p !== null);
  return parts.length === 0 ? '전체' : parts.join(' · ');
}

function parseStack(s: JsonRecord): StackEvidence {
  const t = asRecord(s.trend);
  const points = xyPoints(t.points, 'op_h', 'dv_mv');
  const line = xyPoints(t.line, 'op_h', 'dv_mv');
  const perH = { slope: asNumber(t.slope_uv_per_h), low: asNumber(t.ci_low_uv_per_h), high: asNumber(t.ci_high_uv_per_h) };
  const mvPerH = (v: number | null) => (v === null ? null : v / 1000);
  const trend: TrendView | null = points.length === 0 ? null : { xKind: 'op_hours', yName: '조건 보정 셀 전압 잔차 (mV)', points, line: line.length >= 2 ? line : null, slope: mvPerH(perH.slope), ciLow: mvPerH(perH.low), ciHigh: mvPerH(perH.high), slopeText: slopeText(perH.slope, perH.low, perH.high, 'µV/h', 1), changeStart: asNumber(t.change_start_op_h) };
  return {
    kind: 'stack',
    slopeBasis: asString(t.basis) === 'post_change' ? 'post_change' : 'full',
    fullSlopeUvPerH: asNumber(asRecord(t.full).slope_uv_per_h),
    breakInHours: asNumber(s.break_in_hours),
    excludedBreakIn: asNumber(s.excluded_break_in),
    bins: asArray(s.bins).flatMap((item) => {
      const b = asRecord(item);
      const key = asString(b.key);
      return key === null ? [] : [{ key, label: stackBinLabel(key), n: asNumber(b.n) ?? 0, medianMv: asNumber(b.median_v_mv), opHMin: asNumber(b.op_h_min), opHMax: asNumber(b.op_h_max) }];
    }),
    trend,
    checks: parseChecks(s.checks),
  };
}

function parseCellImbalance(s: JsonRecord): CellImbalanceEvidence {
  const t = asRecord(s.trend);
  const points = xyPoints(t.points, 't', 'dv_mv');
  const line = xyPoints(t.line, 't', 'dv_mv');
  const perMonth = { slope: asNumber(t.slope_mv_per_month), low: asNumber(t.ci_low_mv_per_month), high: asNumber(t.ci_high_mv_per_month) };
  const perMs = (v: number | null) => (v === null ? null : v / MS_PER_MONTH);
  const peers = asRecord(s.peers);
  return {
    kind: 'cell_imbalance',
    source: asString(s.source) ?? 'charge_end',
    reference: { n: asNumber(asRecord(s.reference).n) ?? 0, medianMv: asNumber(asRecord(s.reference).median_mv) },
    recent: { n: asNumber(asRecord(s.recent).n) ?? 0, medianMv: asNumber(asRecord(s.recent).median_mv) },
    trend: points.length === 0 ? null : { xKind: 'time', yName: '셀 전압 편차 (mV)', points, line: line.length >= 2 ? line : null, slope: perMs(perMonth.slope), ciLow: perMs(perMonth.low), ciHigh: perMs(perMonth.high), slopeText: slopeText(perMonth.slope, perMonth.low, perMonth.high, 'mV/월', 1), changeStart: asNumber(t.change_start) },
    peers: {
      modifiedZ: asNumber(peers.modified_z),
      values: asArray(peers.values_mv).flatMap((item) => {
        const assetId = asNumber(asRecord(item).asset_id);
        return assetId === null ? [] : [{ assetId, dvMv: asNumber(asRecord(item).dv_mv) }];
      }),
    },
  };
}

function parsePvPeer(s: JsonRecord): PvPeerEvidence {
  return {
    kind: 'pv_peer',
    excludedDays: asNumber(s.excluded_days),
    days: asArray(s.days).flatMap((item) => {
      const d = asRecord(item);
      const day = asString(d.day);
      return day === null ? [] : [{ day, kwhPerKwp: asNumber(d.kwh_per_kwp), peerMedian: asNumber(d.peer_median), deviationPct: asNumber(d.deviation_pct), modifiedZ: asNumber(d.modified_z), peers: asNumber(d.peers), flagged: asBoolean(d.flagged) ?? false }];
    }),
  };
}

const spans = (value: unknown): Span[] =>
  asArray(value).flatMap((item) => {
    const start = asNumber(asRecord(item).start);
    const end = asNumber(asRecord(item).end);
    return start === null || end === null ? [] : [{ start, end }];
  });

function parseDq(s: JsonRecord): DqEvidence {
  return {
    kind: 'dq',
    gapPoints: asNumber(s.gap_points),
    flatlinePoints: asNumber(s.flatline_points),
    points: asArray(s.points).flatMap((item) => {
      const p = asRecord(item);
      const pointId = asNumber(p.point_id);
      return pointId === null ? [] : [{ pointId, sourceKey: asString(p.source_key) ?? '', metricKey: asString(p.metric_key) ?? '', completeness: asNumber(p.completeness), gapHours: asNumber(p.gap_hours), gaps: spans(p.gaps), longestFlatlineHours: asNumber(p.longest_flatline_hours), flatlines: spans(p.flatlines) }];
    }),
  };
}

/** P3 근거는 탐지기 id(인자 → 스냅샷 detector 필드)·method로 p3-evidence.ts가 읽고, 나머지는 스냅샷의 method로 형식을 고른다. 모르는 형식은 unknown */
export function parseEvidence(snapshot: unknown, detectorId?: string | null): EvidenceView {
  const p3 = parseP3Evidence(snapshot, detectorId);
  if (p3 !== null) return p3;
  const s = asRecord(snapshot);
  switch (asString(s.method)) {
    case 'matched_ratio':
      return parseCapacity(s);
    case 'binned_residual_theil_sen':
      return parseStack(s);
    case 'median_shift_trend_peer':
      return parseCellImbalance(s);
    case 'peer_modified_z':
      return parsePvPeer(s);
    case 'gap_flatline_summary':
      return parseDq(s);
    default:
      return { kind: 'unknown' };
  }
}
