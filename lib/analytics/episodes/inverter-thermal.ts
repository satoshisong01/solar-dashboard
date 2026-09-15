// 인버터 열 출력저감 입력 표본 (순수, inv.thermal_derating 입력): 사이트 인버터들을 같은 시각 버킷(기본 5분)으로 맞춘다.
// 동종 비교가 같은 시각에 여러 인버터를 봐야 해서 설비 하나짜리 에피소드 대신 버킷 표본을 만든다 (분석 창만큼 원시에서 계산).
// 입력 메트릭: 인버터마다 ac.power(kW, 필수) · heatsink.temp(°C) · ac.power.limit(%) / 사이트 기상 ambient.temp(°C)
import { MS_PER_MINUTE, MS_PER_SECOND, type AssetSeries, type TimeWindow } from '../types';
import { goodPoints, meanValue, nominalPeriodMs, pointsIn, valueAtOrBefore, valueNear, type TimedValue } from './series';

export interface InverterThermalSource {
  readonly assetId: number;
  readonly dcKwp: number;
  readonly series: AssetSeries;
}

export interface InverterThermalSample {
  /** 버킷 시작 */
  readonly ts: number;
  readonly assetId: number;
  /** 버킷 평균 AC 출력 / 연결 DC 용량 [kW/kWp] */
  readonly kwPerKwp: number;
  readonly heatsinkC: number | null;
  /** 출력 제한 설정값 [%]. 신호가 없거나 15분 넘게 오래됐으면 null */
  readonly limitPct: number | null;
  readonly ambientC: number | null;
}

export const DEFAULT_THERMAL_BUCKET_S = 300;

interface SourceSignals {
  readonly source: InverterThermalSource;
  readonly power: readonly TimedValue[];
  readonly heatsink: readonly TimedValue[];
  readonly limit: readonly TimedValue[];
  readonly heatsinkToleranceMs: number;
}

/** 버킷마다 인버터별 표본. 그 버킷에 AC 출력 샘플이 없는 인버터는 뺀다 */
export function inverterThermalSamples(sources: readonly InverterThermalSource[], ambientSeries: AssetSeries, window: TimeWindow, bucketS = DEFAULT_THERMAL_BUCKET_S): InverterThermalSample[] {
  const bucketMs = bucketS * MS_PER_SECOND;
  const ambient = goodPoints(ambientSeries, 'ambient.temp');
  const ambientTolerance = 1.5 * nominalPeriodMs(ambient, 5 * MS_PER_MINUTE);
  const signals: SourceSignals[] = sources
    .filter((s) => s.dcKwp > 0)
    .map((source) => {
      const heatsink = goodPoints(source.series, 'heatsink.temp');
      return { source, power: pointsIn(goodPoints(source.series, 'ac.power'), window), heatsink, limit: goodPoints(source.series, 'ac.power.limit'), heatsinkToleranceMs: bucketMs / 2 + nominalPeriodMs(heatsink, bucketMs) };
    });
  const firstBucket = Math.floor(window.start / bucketMs) * bucketMs;
  const count = Math.max(0, Math.ceil((window.end - firstBucket) / bucketMs));
  return Array.from({ length: count }, (_, i) => firstBucket + i * bucketMs).flatMap((ts) => {
    const range = { start: ts, end: ts + bucketMs };
    const ambientC = valueNear(ambient, ts + bucketMs / 2, ambientTolerance);
    return signals.flatMap(({ source, power, heatsink, limit, heatsinkToleranceMs }) => {
      const kw = meanValue(pointsIn(power, range));
      if (kw === null) return [];
      return [
        {
          ts,
          assetId: source.assetId,
          kwPerKwp: Math.max(0, kw) / source.dcKwp,
          heatsinkC: valueNear(heatsink, ts + bucketMs / 2, heatsinkToleranceMs),
          limitPct: valueAtOrBefore(limit, ts + bucketMs - 1, 15 * MS_PER_MINUTE),
          ambientC,
        },
      ];
    });
  });
}
