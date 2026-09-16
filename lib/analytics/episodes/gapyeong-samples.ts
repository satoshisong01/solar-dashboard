// 가평 구성 탐지기 3종의 입력 표본을 1시간 롤업에서 만든다 (순수). 에피소드가 아니라 시간 단위 표본이라 여기서 따로 조립한다.
//   prv.seat_leak   무유동(연료전지 정지) 연속 시간 묶음 + 그 시간의 감압밸브 하류·상류 압력
//   hx.fouling      정상상태(연료전지 운전 + 2차측 유량) 시간의 열교환기 4점 온도·유량·차압
//   o2.purity_drift 전해조 운전 시간의 애노드 원가스 HTO 일별 중앙값·최댓값
// 1시간 롤업으로 충분한 이유: 크리프는 mbar/h, 접근온도는 K, HTO는 vol% 단위의 느린 현상이다.
import { kstDayStart } from '../types';

/** 1시간 롤업 한 행 (lib/analysis/series.ts loadHourly 결과와 같은 모양) */
export interface HourRowLike {
  readonly assetId: number;
  readonly metricKey: string;
  readonly hourStart: number;
  readonly nGood: number;
  readonly avg: number | null;
  readonly min?: number | null;
  readonly max?: number | null;
}

type Index = ReadonlyMap<string, HourRowLike>;

const key = (assetId: number, metricKey: string, hourStart: number): string => `${assetId}|${metricKey}|${hourStart}`;

export function indexHours(rows: readonly HourRowLike[]): Index {
  const index = new Map<string, HourRowLike>();
  for (const row of rows) if (row.nGood > 0) index.set(key(row.assetId, row.metricKey, row.hourStart), row);
  return index;
}

const avgOf = (index: Index, assetId: number | null, metricKey: string, hourStart: number): number | null => {
  if (assetId === null) return null;
  const row = index.get(key(assetId, metricKey, hourStart));
  return row && row.avg !== null && Number.isFinite(row.avg) ? row.avg : null;
};

const maxOf = (index: Index, assetId: number | null, metricKey: string, hourStart: number): number | null => {
  if (assetId === null) return null;
  const row = index.get(key(assetId, metricKey, hourStart));
  if (!row) return null;
  const values = [row.max, row.avg].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  return values.length > 0 ? Math.max(...values) : null;
};

/** 표본을 만들 시간 목록 (오름차순, 중복 제거) */
const hoursOf = (rows: readonly HourRowLike[]): number[] => [...new Set(rows.map((r) => r.hourStart))].sort((a, b) => a - b);

// ── prv.seat_leak ────────────────────────────────────────────────────────

/** 무유동 hold 구간의 한 시간 */
export interface PrvHoldHour {
  readonly hourStart: number;
  /** 감압밸브 하류 압력 시간 평균 [bar] */
  readonly outletBar: number;
  /** 상류(버퍼) 압력 시간 평균 [bar]. 공급압 효과 판별용 */
  readonly inletBar: number | null;
  readonly ambientC: number | null;
  /** 설정 압력 [bar] (현장 재조정 판별용) */
  readonly setpointBar: number | null;
}

/** 연속 무유동 시간 묶음 */
export interface PrvHold {
  readonly start: number;
  readonly end: number;
  readonly hours: readonly PrvHoldHour[];
}

export interface PrvHoldSources {
  readonly prvAssetId: number;
  /**
   * 하류 압력(h2.pressure)을 찾을 설비 순서. 감압밸브 스키드에 계기가 붙어 있으면 그 값을 쓰고,
   * 도면에 따라 연료전지 입구(PT-202)에 붙어 있으면 연료전지 설비에서 읽는다. 앞에서 값이 나오는 설비를 쓴다.
   */
  readonly outletAssetIds: readonly number[];
  /** 연료전지 설비 (무유동 판정: fc.h2.consumption 시간 최댓값이 idleMaxKgH 이하) */
  readonly fcAssetIds: readonly number[];
  /** 상류 압력을 재는 설비 (수소 버퍼 뱅크) */
  readonly bufferAssetIds: readonly number[];
  readonly wxAssetId: number | null;
  readonly idleMaxKgH: number;
}

const MS_PER_HOUR = 3_600_000;

/**
 * 무유동 hold 구간: 연료전지 수소 소비 시간 최댓값이 idleMaxKgH 이하이고 하류 압력 값이 있는 시간을 이어 붙인다.
 * 소비 데이터가 없는 시간은 무유동으로 보지 않는다 (판정할 수 없는 시간을 정지로 채우면 유동 구간이 섞인다).
 */
export function prvHolds(rows: readonly HourRowLike[], sources: PrvHoldSources): PrvHold[] {
  const index = indexHours(rows);
  const holds: PrvHold[] = [];
  let current: PrvHoldHour[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last && current.length >= 2) holds.push({ start: first.hourStart, end: last.hourStart + MS_PER_HOUR, hours: current });
    current = [];
  };
  for (const hourStart of hoursOf(rows)) {
    const consumptions = sources.fcAssetIds.map((id) => maxOf(index, id, 'fc.h2.consumption', hourStart));
    const idle = consumptions.length > 0 && consumptions.every((v) => v !== null && Math.abs(v) <= sources.idleMaxKgH);
    const outletBar = sources.outletAssetIds.map((id) => avgOf(index, id, 'h2.pressure', hourStart)).find((v) => v !== null) ?? null;
    if (!idle || outletBar === null) {
      flush();
      continue;
    }
    const inletBar = sources.bufferAssetIds.map((id) => avgOf(index, id, 'h2.pressure', hourStart)).find((v) => v !== null) ?? null;
    current.push({
      hourStart,
      outletBar,
      inletBar,
      ambientC: avgOf(index, sources.wxAssetId, 'ambient.temp', hourStart),
      setpointBar: avgOf(index, sources.prvAssetId, 'h2.pressure.setpoint', hourStart),
    });
  }
  flush();
  return holds;
}

// ── hx.fouling ───────────────────────────────────────────────────────────

/** 열교환기 정상상태 한 시간 */
export interface HxSample {
  readonly hourStart: number;
  readonly hotInC: number;
  readonly hotOutC: number | null;
  readonly coldInC: number | null;
  readonly coldOutC: number;
  /** 2차측 유량 [m³/h] */
  readonly coldFlowM3H: number | null;
  readonly hotFlowM3H: number | null;
  readonly heatKw: number | null;
  readonly diffHotKpa: number | null;
}

/** 열교환기 표본: 1차측 입구·2차측 출구 온도가 모두 있고 1차측이 2차측보다 뜨거운 시간만 */
export function hxSamples(rows: readonly HourRowLike[], hxAssetId: number): HxSample[] {
  const index = indexHours(rows);
  return hoursOf(rows).flatMap((hourStart) => {
    const hotInC = avgOf(index, hxAssetId, 'hx.temp.hot.in', hourStart);
    const coldOutC = avgOf(index, hxAssetId, 'hx.temp.cold.out', hourStart);
    if (hotInC === null || coldOutC === null || hotInC <= coldOutC) return [];
    return [{
      hourStart,
      hotInC,
      hotOutC: avgOf(index, hxAssetId, 'hx.temp.hot.out', hourStart),
      coldInC: avgOf(index, hxAssetId, 'hx.temp.cold.in', hourStart),
      coldOutC,
      coldFlowM3H: avgOf(index, hxAssetId, 'hx.flow.cold', hourStart),
      hotFlowM3H: avgOf(index, hxAssetId, 'hx.flow.hot', hourStart),
      heatKw: avgOf(index, hxAssetId, 'hx.heat.recovered', hourStart),
      diffHotKpa: avgOf(index, hxAssetId, 'hx.pressure.diff.hot', hourStart),
    }];
  });
}

// ── o2.purity_drift ──────────────────────────────────────────────────────

/** 전해조 운전 시간만 모은 HTO 하루 */
export interface HtoDay {
  /** KST 0시 epoch ms */
  readonly day: number;
  /** 운전 시간 HTO 중앙값 [vol%] */
  readonly medianPct: number;
  /** 운전 시간 HTO 최댓값 [vol%] */
  readonly maxPct: number;
  /** 표본에 들어간 운전 시간 수 */
  readonly hours: number;
  /** 그날 전해조 부하율 중앙값 (부분부하 판별용). 전류 데이터가 없으면 null */
  readonly loadFraction: number | null;
}

export interface HtoSources {
  /** HTO를 재는 설비 (산소 계통, 없으면 전해조) */
  readonly htoAssetId: number;
  readonly elzAssetId: number | null;
  readonly elzStackAssetIds: readonly number[];
  /** 전해조 정격 전류 [A] (부하율 분모). 없으면 부하율 null */
  readonly ratedCurrentA: number | null;
  /** 운전 판정: 전해조 수소 유량이 이 값보다 크면 운전 중 [kg/h] */
  readonly runningMinKgH: number;
}

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
};

/** 전해조가 도는 시간의 HTO만 KST 날짜로 모은다. 정지 중 값은 공정 신호가 아니라 잔류 가스라 뺀다 */
export function htoDays(rows: readonly HourRowLike[], sources: HtoSources): HtoDay[] {
  const index = indexHours(rows);
  const byDay = new Map<number, { hto: number[]; load: number[] }>();
  for (const hourStart of hoursOf(rows)) {
    const flowKgH = avgOf(index, sources.elzAssetId, 'h2.flow.mass', hourStart);
    if (flowKgH === null || flowKgH <= sources.runningMinKgH) continue;
    const hto = avgOf(index, sources.htoAssetId, 'h2.in.o2', hourStart);
    if (hto === null) continue;
    const day = kstDayStart(hourStart);
    const bucket = byDay.get(day) ?? { hto: [], load: [] };
    bucket.hto.push(hto);
    const currents = sources.elzStackAssetIds.map((id) => avgOf(index, id, 'stack.current', hourStart)).filter((v): v is number => v !== null);
    if (currents.length > 0 && sources.ratedCurrentA !== null && sources.ratedCurrentA > 0) {
      bucket.load.push(currents.reduce((sum, v) => sum + v, 0) / currents.length / sources.ratedCurrentA);
    }
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, bucket]) => ({ day, medianPct: medianOf(bucket.hto), maxPct: Math.max(...bucket.hto), hours: bucket.hto.length, loadFraction: bucket.load.length > 0 ? medianOf(bucket.load) : null }));
}
