// 차트 화면의 URL 상태(선택 포인트·기간). 순수 모듈 (서버·클라이언트 공용).
import { INT4_MAX, SERIES_LIMITS } from './series-types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

export const RANGE_PRESETS = Object.freeze({
  '24h': { label: '24시간', spanMs: 24 * HOUR_MS },
  '7d': { label: '7일', spanMs: 7 * 24 * HOUR_MS },
  '30d': { label: '30일', spanMs: 30 * 24 * HOUR_MS },
});

export type RangePreset = keyof typeof RANGE_PRESETS;
export const RANGE_PRESET_KEYS = Object.keys(RANGE_PRESETS) as RangePreset[];
export const DEFAULT_RANGE_PRESET: RangePreset = '24h';

export type RangeSelection =
  | Readonly<{ kind: 'preset'; preset: RangePreset }>
  | Readonly<{ kind: 'custom'; fromMs: number; toMs: number }>;

export interface ResolvedRange {
  readonly selection: RangeSelection;
  readonly fromMs: number;
  readonly toMs: number;
}

export type SearchParamValue = string | string[] | undefined;

/** Next searchParams 값에서 첫 문자열 */
export function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const isPreset = (value: string | undefined): value is RangePreset => value !== undefined && Object.hasOwn(RANGE_PRESETS, value);

function parseIso(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * range=24h|7d|30d 또는 range=custom&from=ISO&to=ISO. 틀린 값은 기본(24시간)으로 되돌린다.
 * 프리셋의 끝은 현재 시각을 분 단위로 내림한 시각이다.
 */
export function resolveRange(
  params: Readonly<{ range?: string; from?: string; to?: string }>,
  nowMs: number,
): ResolvedRange {
  if (params.range === 'custom') {
    const fromMs = parseIso(params.from);
    const toMs = parseIso(params.to);
    if (fromMs !== null && toMs !== null && fromMs < toMs && toMs - fromMs <= SERIES_LIMITS.maxSpanMs) {
      return { selection: { kind: 'custom', fromMs, toMs }, fromMs, toMs };
    }
  }
  const preset = isPreset(params.range) ? params.range : DEFAULT_RANGE_PRESET;
  const toMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  return { selection: { kind: 'preset', preset }, fromMs: toMs - RANGE_PRESETS[preset].spanMs, toMs };
}

/** points=1,2,3 → 허용된 id만, 중복 제거, 최대 개수까지 (입력 순서 유지) */
export function parsePointIds(raw: string | undefined, allowed: ReadonlySet<number>, max = SERIES_LIMITS.maxPointIds): number[] {
  if (!raw) return [];
  const ids = raw
    .split(',')
    .map((part) => parsePositiveIntParam(part.trim()))
    .filter((id): id is number => id !== null && allowed.has(id));
  return [...new Set(ids)].slice(0, max);
}

/** 화면 URL 쿼리 문자열 (앞의 '?' 없음). 선택을 모두 끈 상태도 남기도록 points는 비어 있어도 넣는다 */
export function buildViewSearch(pointIds: readonly number[], selection: RangeSelection): string {
  const params = new URLSearchParams();
  params.set('points', pointIds.join(','));
  if (selection.kind === 'preset') {
    params.set('range', selection.preset);
  } else {
    params.set('range', 'custom');
    params.set('from', new Date(selection.fromMs).toISOString());
    params.set('to', new Date(selection.toMs).toISOString());
  }
  return params.toString();
}

/** datetime-local 값(KST, 2026-09-14T20:05) → epoch ms. 형식이 틀리면 null */
export function fromKstInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

/** 동적 경로 조각 디코딩. 잘못된 퍼센트 인코딩이면 null (notFound 처리용) */
export function decodeRouteParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** 양의 정수 경로 조각(설비 id 등). 아니면 null */
export function parsePositiveIntParam(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= INT4_MAX ? Number(value) : null;
}
