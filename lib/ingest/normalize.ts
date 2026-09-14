// 봉투 → 저장할 샘플·미매핑 태그·이벤트로 바꾸는 순수 함수 (설계 §5.1 규칙 4~8). DB·시계 접근 없음.
import { sampleTimestamps, type EventSeverity, type IngestEnvelope, type IngestEvent } from './envelope';
import { QUALITY } from './quality';

/** 서버 수신 시각보다 이만큼 넘게 미래인 샘플은 거부한다 */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** 게이트웨이 시계가 이만큼 넘게 어긋나면 CLOCK_SUSPECT */
export const CLOCK_SKEW_LIMIT_MS = 120_000;
/** 수신 시각보다 이만큼 이상 과거인 샘플은 LATE */
export const LATE_THRESHOLD_MS = 3_600_000;
/** 이보다 과거(2000-01-01T00:00Z) 샘플은 게이트웨이 시계 초기화로 보고 거부한다 */
export const MIN_SAMPLE_TS_MS = Date.UTC(2000, 0, 1);

/** source_key → 포인트 매핑과 정규화 파라미터 */
export interface PointMapping {
  readonly pointId: number;
  readonly scale: number;
  readonly valueOffset: number;
  readonly hardMin: number | null;
  readonly hardMax: number | null;
}

export interface NormalizeOptions {
  readonly pointsBySource: ReadonlyMap<string, PointMapping>;
  /** 서버가 배치를 받은 시각 (재처리 때는 원래 수신 시각) */
  readonly receivedAtMs: number;
  /** 재처리(replay)면 모든 샘플에 REPROCESSED 비트를 붙인다 */
  readonly reprocessed?: boolean;
}

export interface NormalizedSample {
  readonly pointId: number;
  readonly tsMs: number;
  readonly value: number;
  readonly quality: number;
}

export interface UnmappedSeries {
  readonly sourceKey: string;
  readonly unit: string;
  readonly sampleCount: number;
}

export interface SampleStats {
  /** series[].v 길이 합 */
  readonly total: number;
  /** 매핑된 포인트의 저장 후보 (중복 여부는 DB가 판단) */
  readonly candidates: number;
  /** 미래 +5분 초과 또는 2000년 이전 */
  readonly rejected: number;
  /** 매핑되지 않은 태그의 샘플 */
  readonly unmapped: number;
  /** v가 null인 결측 (저장하지 않음) */
  readonly missing: number;
}

export interface NormalizedBatch {
  readonly samples: readonly NormalizedSample[];
  readonly unmapped: readonly UnmappedSeries[];
  readonly stats: SampleStats;
  /** sent_at − 수신 시각 (게이트웨이 시계가 빠르면 +) */
  readonly skewMs: number;
  readonly clockSuspect: boolean;
}

/** sent_at 기준 게이트웨이 시계 오차와 CLOCK_SUSPECT 여부 */
export function assessClock(envelope: Pick<IngestEnvelope, 'sent_at' | 'clock'>, receivedAtMs: number) {
  const skewMs = Date.parse(envelope.sent_at) - receivedAtMs;
  return { skewMs, clockSuspect: !envelope.clock.ntp_synced || Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS };
}

/** 정규값 = 원본값 × scale + value_offset */
export function applyScale(raw: number, mapping: Pick<PointMapping, 'scale' | 'valueOffset'>): number {
  return raw * mapping.scale + mapping.valueOffset;
}

function sampleQuality(value: number, tsMs: number, deviceCode: number, mapping: PointMapping, base: number, receivedAtMs: number): number {
  let quality = base;
  if (deviceCode !== 0) quality |= QUALITY.DEVICE_BAD;
  if ((mapping.hardMin !== null && value < mapping.hardMin) || (mapping.hardMax !== null && value > mapping.hardMax)) {
    quality |= QUALITY.HARD_RANGE;
  }
  if (receivedAtMs - tsMs >= LATE_THRESHOLD_MS) quality |= QUALITY.LATE;
  return quality;
}

function isRejectedTimestamp(tsMs: number, receivedAtMs: number): boolean {
  return tsMs > receivedAtMs + FUTURE_TOLERANCE_MS || tsMs < MIN_SAMPLE_TS_MS;
}

/** 같은 source_key가 여러 시계열로 나뉘어 와도 미매핑 인박스에는 한 행으로 합친다 */
function mergeUnmapped(items: readonly UnmappedSeries[]): readonly UnmappedSeries[] {
  const merged = new Map<string, UnmappedSeries>();
  for (const item of items) {
    const previous = merged.get(item.sourceKey);
    merged.set(item.sourceKey, previous ? { ...item, sampleCount: previous.sampleCount + item.sampleCount } : item);
  }
  return [...merged.values()];
}

export function normalizeSamples(envelope: Pick<IngestEnvelope, 'series' | 'sent_at' | 'clock'>, options: NormalizeOptions): NormalizedBatch {
  const { pointsBySource, receivedAtMs } = options;
  const { skewMs, clockSuspect } = assessClock(envelope, receivedAtMs);
  const base = (clockSuspect ? QUALITY.CLOCK_SUSPECT : 0) | (options.reprocessed ? QUALITY.REPROCESSED : 0);

  const samples: NormalizedSample[] = [];
  const unmapped: UnmappedSeries[] = [];
  let total = 0;
  let rejected = 0;
  let missing = 0;

  for (const series of envelope.series) {
    total += series.v.length;
    const mapping = pointsBySource.get(series.src);
    if (!mapping) {
      unmapped.push({ sourceKey: series.src, unit: series.unit, sampleCount: series.v.length });
      continue;
    }
    const timestamps = sampleTimestamps(series);
    series.v.forEach((raw, index) => {
      const tsMs = timestamps[index];
      if (raw === null) {
        missing += 1;
      } else if (isRejectedTimestamp(tsMs, receivedAtMs)) {
        rejected += 1;
      } else {
        const value = applyScale(raw, mapping);
        const quality = sampleQuality(value, tsMs, series.q?.[index] ?? 0, mapping, base, receivedAtMs);
        samples.push({ pointId: mapping.pointId, tsMs, value, quality });
      }
    });
  }

  const unmappedSamples = unmapped.reduce((sum, item) => sum + item.sampleCount, 0);
  return {
    samples,
    unmapped: mergeUnmapped(unmapped),
    stats: { total, candidates: samples.length, rejected, unmapped: unmappedSamples, missing },
    skewMs,
    clockSuspect,
  };
}

/** 사이트 설비 코드(예: H2BANK1/TANK1) → 설비 id와 그 설비 종류의 안전 이벤트 코드 */
export interface EventAsset {
  readonly assetId: number;
  readonly safetyEventCodes: readonly string[];
}

export interface EventContext {
  readonly assetsByCode: ReadonlyMap<string, EventAsset>;
  /** 모든 설비 종류의 안전 이벤트 코드 (설비를 찾지 못한 이벤트 판정용) */
  readonly allSafetyEventCodes: ReadonlySet<string>;
}

export interface NormalizedEvent {
  readonly sourceKey: string;
  readonly tsMs: number;
  readonly code: string;
  readonly severity: EventSeverity;
  readonly text: string | null;
  readonly assetId: number | null;
  readonly isSafety: boolean;
}

/** 'H2BANK1/TANK1/PSV' → ['H2BANK1/TANK1/PSV', 'H2BANK1/TANK1', 'H2BANK1'] (긴 것부터) */
export function sourceKeyPrefixes(sourceKey: string): readonly string[] {
  const parts = sourceKey.split('/');
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/'));
}

/**
 * 이벤트 원본 태그를 가장 긴 설비 코드 접두어로 설비에 연결하고 안전 이벤트 여부를 정한다.
 * 안전 이벤트: 연결된 설비와 상위 설비 종류의 safety_event_codes에 있는 코드, 또는 severity=critical.
 * (critical인데 어느 목록에도 없는 코드도 안전으로 본다. 설비를 못 찾으면 전체 목록으로 판정한다.)
 * 안전 레인은 분석을 우회하므로 시계가 틀린 이벤트도 거부하지 않는다.
 */
export function normalizeEvents(events: readonly IngestEvent[], context: EventContext): readonly NormalizedEvent[] {
  return events.map((event) => {
    const matches = sourceKeyPrefixes(event.src).flatMap((prefix) => context.assetsByCode.get(prefix) ?? []);
    const safetyCodes = matches.length > 0 ? new Set(matches.flatMap((asset) => asset.safetyEventCodes)) : context.allSafetyEventCodes;
    return {
      sourceKey: event.src,
      tsMs: event.ts,
      code: event.code,
      severity: event.severity,
      text: event.text ?? null,
      assetId: matches[0]?.assetId ?? null,
      isSafety: safetyCodes.has(event.code) || event.severity === 'critical',
    };
  });
}
