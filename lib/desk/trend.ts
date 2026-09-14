// 추세 산점도용 Theil–Sen 선과 기울기 95% CI 밴드. 순수 모듈 (서버·클라이언트 공용).
// Theil–Sen 절편은 median(y) − slope·median(x)라 추세선은 (median x, median y)를 지난다.
// 밴드는 그 점을 축으로 기울기 CI 하한·상한 선을 그린 범위다 (나비넥타이 모양: 축에서 폭 0, 양 끝에서 넓어진다).

export type XYPoint = readonly [x: number, y: number];

export interface TrendView {
  /** x축 종류: 시각(epoch ms) 또는 누적 운전시간(h) */
  readonly xKind: 'time' | 'op_hours';
  readonly yName: string;
  readonly points: readonly XYPoint[];
  /** 추세선 두 끝점 (근거에 없으면 null) */
  readonly line: readonly XYPoint[] | null;
  /** 기울기와 95% CI (y 단위 / x 단위) */
  readonly slope: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  /** 사람이 읽는 기울기: '−2.50 %/월 (95% CI −2.72 ~ −2.29)' */
  readonly slopeText: string | null;
  /** CUSUM 변화 시작 (x 값) */
  readonly changeStart: number | null;
}

export interface TrendBand {
  readonly lower: readonly XYPoint[];
  readonly upper: readonly XYPoint[];
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** 두 끝점 선의 x 위치 값 (선 밖이면 연장) */
export function lineValueAt(line: readonly XYPoint[], x: number): number | null {
  const [a, b] = line;
  if (!a || !b) return null;
  if (a[0] === b[0]) return a[1];
  return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
}

/** 기울기 CI 밴드: 점들의 x 중앙값에서 추세선 값을 축으로, 선 구간 양 끝과 축 세 점으로 하한·상한 */
export function trendBand(trend: Pick<TrendView, 'points' | 'line' | 'slope' | 'ciLow' | 'ciHigh'>): TrendBand | null {
  const { line, ciLow, ciHigh } = trend;
  if (!line || line.length < 2 || ciLow === null || ciHigh === null || trend.points.length === 0) return null;
  const pivotX = median(trend.points.map(([x]) => x));
  const pivotY = lineValueAt(line, pivotX);
  if (pivotY === null) return null;
  const xs = [...new Set([line[0]?.[0] ?? pivotX, pivotX, line[line.length - 1]?.[0] ?? pivotX])].sort((a, b) => a - b);
  const at = (x: number, slope: number): number => pivotY + slope * (x - pivotX);
  return {
    lower: xs.map((x): XYPoint => [x, Math.min(at(x, ciLow), at(x, ciHigh))]),
    upper: xs.map((x): XYPoint => [x, Math.max(at(x, ciLow), at(x, ciHigh))]),
  };
}
