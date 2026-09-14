// 메모리 모드 시계열(타입 배열) → 분석 파이프라인 입력(Sample 배열). 필요한 설비·메트릭만 바꾼다.
import type { SeriesRequest } from '@/lib/analytics/pipeline/sources';
import type { PipelineAsset } from '@/lib/analytics/pipeline/types';
import type { AssetSeries, Sample } from '@/lib/analytics/types';
import { pointKey, type MemorySeries } from '../memory';

export function toSamples(series: MemorySeries): Sample[] {
  const samples: Sample[] = new Array<Sample>(series.ts.length); // 수십만 개라 map 대신 미리 잡은 배열을 채운다
  for (let i = 0; i < series.ts.length; i += 1) samples[i] = { ts: series.ts[i] as number, value: series.value[i] as number, quality: series.quality[i] as number };
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

