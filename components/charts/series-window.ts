// 시계열 차트의 순수 계산: 단위별 y축 배정, 확대 구간 계산, 확대 재조회 결과 병합.
import type { SeriesPayload } from '@/lib/data/series-types';

export const MAX_Y_AXES = 2;

export interface AxisAssignment {
  /** 축 순서대로 단위 (왼쪽, 오른쪽) */
  readonly axisUnits: readonly string[];
  /** 입력 순서대로 축 번호. 세 번째 단위부터는 null (그리지 않음) */
  readonly axisIndexes: readonly (number | null)[];
}

/** 처음 나온 단위 순서로 y축을 최대 2개 배정한다 */
export function assignAxes(units: readonly string[]): AxisAssignment {
  const axisUnits = [...new Set(units)].slice(0, MAX_Y_AXES);
  return { axisUnits, axisIndexes: units.map((unit) => (axisUnits.includes(unit) ? axisUnits.indexOf(unit) : null)) };
}

/** 이미 고른 단위에 이 단위를 더해도 y축 2개 안에 드는가 */
export function fitsAxes(selectedUnits: readonly string[], unit: string): boolean {
  const units = new Set(selectedUnits);
  return units.has(unit) || units.size < MAX_Y_AXES;
}

/** 앞에서부터 y축 2개(단위 2종) 안에 드는 항목만 남긴다 (URL로 직접 넣은 선택도 화면 규칙에 맞춘다) */
export function keepWithinAxes<T extends Readonly<{ unit: string }>>(items: readonly T[]): T[] {
  return items.reduce<T[]>((kept, item) => (fitsAxes(kept.map((k) => k.unit), item.unit) ? [...kept, item] : kept), []);
}

/** 축 전체(fromMs~toMs) 대비 dataZoom %를 시각 구간으로 바꾼다 */
export function zoomWindow(fromMs: number, toMs: number, startPct: number, endPct: number): Readonly<{ fromMs: number; toMs: number }> {
  const clamp = (pct: number) => Math.min(100, Math.max(0, pct));
  const span = toMs - fromMs;
  const start = Math.floor(fromMs + (span * clamp(Math.min(startPct, endPct))) / 100);
  const end = Math.ceil(fromMs + (span * clamp(Math.max(startPct, endPct))) / 100);
  return { fromMs: start, toMs: Math.max(end, start + 1) };
}

/** 확대 여유 0.5%: 거의 전체면 처음 받은 데이터를 그대로 쓴다 */
export function isFullZoom(startPct: number, endPct: number): boolean {
  return startPct <= 0.5 && endPct >= 99.5;
}

/**
 * 전체 구간 데이터(base)에서 확대 구간만 세밀한 데이터(detail)로 바꿔 끼운다.
 * 확대 구간 밖은 거친 버킷을 남겨 두어 축소할 때 빈 곳이 생기지 않게 한다.
 */
export function mergeWindow(base: SeriesPayload, detail: SeriesPayload): SeriesPayload {
  const detailById = new Map(detail.series.map((series) => [series.pointId, series.rows]));
  return {
    ...base,
    series: base.series.map((series) => {
      const rows = detailById.get(series.pointId);
      if (!rows) return series;
      // 세밀한 첫 버킷은 경계 정렬 때문에 확대 시작보다 조금 앞설 수 있다. 그 앞까지만 거친 버킷을 남긴다.
      const detailStart = Math.min(detail.fromMs, rows[0]?.[0] ?? detail.fromMs);
      const outside = series.rows.filter(([ts]) => ts < detailStart || ts >= detail.toMs);
      return { pointId: series.pointId, rows: [...outside, ...rows].sort((a, b) => a[0] - b[0]) };
    }),
  };
}
