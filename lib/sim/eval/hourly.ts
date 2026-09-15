// 메모리 모드 시계열 → 1시간 롤업 행 (om.m_1h와 같은 규칙: lib/ingest/rollup.ts computeHourlyRollup).
//   n = 저장된 샘플 수(결측 주입 NaN은 저장되지 않은 샘플이라 뺀다), n_good = BAD 비트 없는 샘플 수,
//   min·max·avg = 저장된 값 전부(품질 무관), first·last = 시각 순 처음·마지막 값.
import { BAD_MASK } from '@/lib/ingest/quality';
import type { LedgerHourRow } from '@/lib/analytics/ledger/types';
import { MS_PER_HOUR } from '@/lib/analytics/types';
import type { MemorySeries } from '../memory';

/** 원장·정지 구간 후보·정류기 효율이 함께 쓰는 롤업 행 (min·max가 항상 있다) */
export type EvalHourRow = LedgerHourRow & { readonly min: number | null; readonly max: number | null };

/** 시계열 하나를 UTC 정시 버킷으로 롤업한다 (한 번 훑기) */
export function hourlyRows(series: MemorySeries, assetId: number, metricKey: string): EvalHourRow[] {
  const rows: EvalHourRow[] = []; // 수천 행이라 한 번에 채운다
  let hour = Number.NaN;
  let n = 0;
  let nGood = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let first = 0;
  let last = 0;
  const flush = () => {
    if (n > 0) rows.push({ assetId, metricKey, periodS: series.periodS, hourStart: hour, n, nGood, avg: sum / n, first, last, min, max });
  };
  for (let i = 0; i < series.ts.length; i += 1) {
    const value = series.value[i] as number;
    if (Number.isNaN(value)) continue;
    const bucket = Math.floor((series.ts[i] as number) / MS_PER_HOUR) * MS_PER_HOUR;
    if (bucket !== hour) {
      flush();
      hour = bucket;
      n = 0;
      nGood = 0;
      sum = 0;
      min = Infinity;
      max = -Infinity;
      first = value;
    }
    n += 1;
    nGood += ((series.quality[i] as number) & BAD_MASK) === 0 ? 1 : 0;
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
    last = value;
  }
  flush();
  return rows;
}
