// 설비 종류별 에피소드 추출 입력: 어떤 설비의 어떤 메트릭을 한 시계열 맵으로 합칠지 (설계 §3.1, 에피소드 추출기 입력 규칙).
//   ess.rack         ← 랙 자신 (충전·방전·휴지 + 전류 계단)
//   pv.inverter      ← 인버터 자신 + 사이트 기상 설비의 경사면 일사량
//   h2.elz.stack     ← 스택 자신 + 상위 전해조 설비(수소 유량·AC 전력·기동 횟수)
//   fc.stack         ← 스택 자신 + 상위 연료전지 설비(수소 소비·AC 출력·기동 횟수) + 형제 블로워 전력
//   h2.compressor    ← 압축기 자신 + 사이트 전해조 제품 유량·저장뱅크 재고·외기 온도
//   h2.storage.tank  ← 용기 자신 + 상위 뱅크 입·출구 밸브 + 사이트 압축기 전력·전해조 유량·연료전지 소비·공급 압력
//   fc.blower        ← 블로워 자신 + 사이트 외기 온도 + 형제 스택 누적 운전시간
//   wx.station       ← 기상 설비 자신
// 한정자(qualifier)가 있는 포인트는 'metric#qualifier' 키로 요청해야 맵에 들어간다 (예: valve.open#inlet).
import type { EpisodeKind } from '../episodes/types';
import type { PipelineAsset } from './types';

export const EXTRACTABLE_CLASSES = ['ess.rack', 'pv.inverter', 'h2.elz.stack', 'fc.stack', 'h2.compressor', 'h2.storage.tank', 'fc.blower', 'wx.station'] as const;
export type ExtractableClass = (typeof EXTRACTABLE_CLASSES)[number];

export const EPISODE_KINDS: Readonly<Record<ExtractableClass, readonly EpisodeKind[]>> = {
  'ess.rack': ['ess.charge', 'ess.discharge', 'ess.rest', 'ess.current_step'],
  'pv.inverter': ['pv.day'],
  'h2.elz.stack': ['el.steady_run', 'el.start'],
  'fc.stack': ['fc.steady_run', 'fc.start'],
  'h2.compressor': ['comp.run'],
  'h2.storage.tank': ['tank.hold'],
  'fc.blower': ['fc.blower_run'],
  'wx.station': ['wx.day'],
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
  'h2.compressor': [
    { relation: 'self', classKey: null, metrics: ['compressor.power', 'compressor.suction.pressure', 'compressor.discharge.pressure', 'compressor.discharge.temp', 'compressor.leak.pressure', 'vibration.rms', 'run.hours'] },
    { relation: 'site', classKey: 'h2.elz', metrics: ['h2.flow.mass'] },
    { relation: 'site', classKey: 'h2.storage.bank', metrics: ['h2.inventory'] },
    { relation: 'site', classKey: 'wx.station', metrics: ['ambient.temp'] },
  ],
  'h2.storage.tank': [
    { relation: 'self', classKey: null, metrics: ['tank.pressure', 'tank.temp'] },
    { relation: 'parent', classKey: 'h2.storage.bank', metrics: ['valve.open#inlet', 'valve.open#outlet'] },
    { relation: 'site', classKey: 'h2.compressor', metrics: ['compressor.power'] },
    { relation: 'site', classKey: 'h2.elz', metrics: ['h2.flow.mass'] },
    { relation: 'site', classKey: 'fc.plant', metrics: ['fc.h2.consumption', 'h2.pressure'] },
  ],
  'fc.blower': [
    { relation: 'self', classKey: null, metrics: ['blower.flow', 'blower.power'] },
    { relation: 'site', classKey: 'wx.station', metrics: ['ambient.temp'] },
    { relation: 'sibling', classKey: 'fc.stack', metrics: ['run.hours'] },
  ],
  'wx.station': [{ relation: 'self', classKey: null, metrics: ['poa.irradiance', 'ghi.irradiance', 'module.temp'] }],
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
