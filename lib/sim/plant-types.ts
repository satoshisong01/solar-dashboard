// 사이트 플랜트 조립에 쓰는 공용 타입과 도우미.
import type { AssetDef, SiteDef } from '@/db/seed/types';
import type { Rng } from './rng';
import type { DegradationResolver } from './scenarios';
import type { WeatherSample } from './weather';

/** 설비 하나의 정규 단위 측정값. 키는 metricKey 또는 `${metricKey}#${qualifier}` */
export type AssetReadings = Readonly<Record<string, number>>;
export type ReadingEntry = readonly [assetCode: string, readings: AssetReadings];

export const readingKey = (metricKey: string, qualifier: string): string =>
  qualifier ? `${metricKey}#${qualifier}` : metricKey;

export interface StepContext {
  /** 스텝 끝 시각 (이 시각의 값을 샘플링한다) */
  readonly tMs: number;
  readonly dtS: number;
  readonly weather: WeatherSample;
  readonly degradation: DegradationResolver;
  /** 계통 주파수 [Hz] (사이트 공통) */
  readonly gridFrequencyHz: number;
  /** 계통 전압 배율 (1 = 정격) */
  readonly gridVoltageFactor: number;
  /** 인버터 출력 제한 설정값 [%] (출력제어 중이 아니면 100) */
  readonly pvLimitPct: number;
}

export interface InitContext {
  readonly site: SiteDef;
  /** 준공 후 경과 일수 — 누적 카운터·열화 초기값 추정에 쓴다 */
  readonly daysInService: number;
  /** 설비별 고정 편차(교정 오프셋·미스매치)용 */
  readonly rng: Rng;
}

export const assetsOfClass = (site: SiteDef, classKey: string): readonly AssetDef[] =>
  site.assets.filter((asset) => asset.classKey === classKey);

export function singleAsset(site: SiteDef, classKey: string): AssetDef {
  const matches = assetsOfClass(site, classKey);
  const [first] = matches;
  if (!first || matches.length !== 1) throw new Error(`${site.code}에 ${classKey} 설비가 정확히 1개여야 합니다 (현재 ${matches.length})`);
  return first;
}

export function nameplateNumber(asset: AssetDef, field: string): number {
  const value = asset.nameplate[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${asset.code} 명판 ${field}이(가) 숫자가 아닙니다`);
  return value;
}

export const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);
