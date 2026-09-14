// 설비 종류별 에피소드 추출 입력: 어떤 설비의 어떤 메트릭을 한 시계열 맵으로 합칠지 (설계 §3.1, 에피소드 추출기 입력 규칙).
//   ess.rack       ← 랙 자신
//   pv.inverter    ← 인버터 자신 + 사이트 기상 설비의 경사면 일사량
//   h2.elz.stack   ← 스택 자신 + 상위 전해조 설비(수소 유량·AC 전력·기동 횟수)
//   fc.stack       ← 스택 자신 + 상위 연료전지 설비(수소 소비·AC 출력·기동 횟수) + 형제 블로워 전력
import type { EpisodeKind } from '../episodes/types';
import type { PipelineAsset } from './types';

export const EXTRACTABLE_CLASSES = ['ess.rack', 'pv.inverter', 'h2.elz.stack', 'fc.stack'] as const;
export type ExtractableClass = (typeof EXTRACTABLE_CLASSES)[number];

export const EPISODE_KINDS: Readonly<Record<ExtractableClass, readonly EpisodeKind[]>> = {
  'ess.rack': ['ess.charge', 'ess.discharge', 'ess.rest'],
  'pv.inverter': ['pv.day'],
  'h2.elz.stack': ['el.steady_run', 'el.start'],
  'fc.stack': ['fc.steady_run', 'fc.start'],
};

type Relation = 'self' | 'parent' | 'sibling' | 'site';

interface SeriesSource {
  readonly relation: Relation;
  /** self가 아니면 찾을 설비 종류 */
  readonly classKey: string | null;
  readonly metrics: readonly string[];
}

const STACK_METRICS = ['stack.current', 'stack.voltage', 'stack.temp', 'run.hours'] as const;

export const SERIES_SOURCES: Readonly<Record<ExtractableClass, readonly SeriesSource[]>> = {
  'ess.rack': [{ relation: 'self', classKey: null, metrics: ['batt.current', 'batt.voltage', 'batt.soc', 'cell.temp.avg', 'cell.voltage.max', 'cell.voltage.min'] }],
  'pv.inverter': [
    { relation: 'self', classKey: null, metrics: ['ac.power', 'ac.power.limit', 'op.state'] },
    { relation: 'site', classKey: 'wx.station', metrics: ['poa.irradiance'] },
  ],
  'h2.elz.stack': [
    { relation: 'self', classKey: null, metrics: STACK_METRICS },
    { relation: 'parent', classKey: 'h2.elz', metrics: ['h2.flow.mass', 'ac.power', 'start.count'] },
  ],
  'fc.stack': [
    { relation: 'self', classKey: null, metrics: STACK_METRICS },
    { relation: 'parent', classKey: 'fc.plant', metrics: ['fc.h2.consumption', 'fc.ac.power', 'start.count'] },
    { relation: 'sibling', classKey: 'fc.blower', metrics: ['blower.power'] },
  ],
};

export const isExtractable = (classKey: string): classKey is ExtractableClass => (EXTRACTABLE_CLASSES as readonly string[]).includes(classKey);

/** 한 설비 에피소드 추출에 필요한 (설비, 메트릭). 메트릭 키가 결과 시계열 맵의 키다 */
export interface SeriesRequest {
  readonly assetId: number;
  readonly metricKey: string;
}

const byCode = (a: PipelineAsset, b: PipelineAsset): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

function relatedAsset(asset: PipelineAsset, source: SeriesSource, siteAssets: readonly PipelineAsset[]): PipelineAsset | null {
  const sameSite = siteAssets.filter((a) => a.siteId === asset.siteId && a.classKey === source.classKey).sort(byCode);
  switch (source.relation) {
    case 'self':
      return asset;
    case 'parent':
      return sameSite.find((a) => a.id === asset.parentId) ?? null;
    case 'sibling':
      return sameSite.find((a) => a.parentId === asset.parentId && a.id !== asset.id) ?? null;
    case 'site':
      return sameSite[0] ?? null;
  }
}

/** 추출에 필요한 시계열 요청. 관련 설비가 없으면 그 메트릭은 빼고(추출기가 없는 메트릭을 null로 다룬다), 추출 대상이 아니면 빈 배열 */
export function seriesRequests(asset: PipelineAsset, siteAssets: readonly PipelineAsset[]): SeriesRequest[] {
  if (!isExtractable(asset.classKey)) return [];
  const requests = SERIES_SOURCES[asset.classKey].flatMap((source) => {
    const related = relatedAsset(asset, source, siteAssets);
    return related ? source.metrics.map((metricKey) => ({ assetId: related.id, metricKey })) : [];
  });
  const keys = requests.map((r) => r.metricKey);
  const duplicate = keys.find((key, i) => keys.indexOf(key) !== i);
  if (duplicate) throw new Error(`시계열 맵 메트릭 키가 겹칩니다: ${asset.classKey} ${duplicate}`);
  return requests;
}
