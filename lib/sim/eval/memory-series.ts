// 메모리 모드 시계열(타입 배열) → 분석 파이프라인 입력(Sample 배열). 필요한 설비·메트릭만 바꾼다.
import type { SeriesRequest } from '@/lib/analytics/pipeline/sources';
import type { PipelineAsset } from '@/lib/analytics/pipeline/types';
import type { AssetSeries, Sample } from '@/lib/analytics/types';
import { pointKey, type MemorySeries } from '../memory';

/** 메모리 시계열 → 원시 샘플. 값이 NaN인 샘플(결측 주입)은 DB에 행이 없는 것과 같게 뺀다 */
export function toSamples(series: MemorySeries): Sample[] {
  const samples: Sample[] = []; // 수십만 개라 map·filter 대신 한 번에 채운다
  for (let i = 0; i < series.ts.length; i += 1) {
    const value = series.value[i] as number;
    if (!Number.isNaN(value)) samples.push({ ts: series.ts[i] as number, value, quality: series.quality[i] as number });
  }
  return samples;
}

/** 요청한 (설비, 메트릭) 시계열 맵. 메모리 결과에 없는 메트릭은 뺀다 */
export function assetSeriesFor(
  requests: readonly SeriesRequest[],
  assetById: ReadonlyMap<number, PipelineAsset>,
  siteCode: string,
  memory: ReadonlyMap<string, MemorySeries>,
): AssetSeries {
  const entries = requests.flatMap((request) => {
    const asset = assetById.get(request.assetId);
    const series = asset ? memory.get(pointKey(`${siteCode}/${asset.code}`, request.metricKey)) : undefined;
    return series ? [[request.metricKey, toSamples(series)] as const] : [];
  });
  return Object.fromEntries(entries);
}

