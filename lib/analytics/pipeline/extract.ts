// 설비 하나의 원시 시계열 맵 → 저장할 에피소드 (순수). 명판이 틀리면 NameplateError.
import { extractEssEpisodes, type EssExtractorParams } from '../episodes/ess';
import { extractPvDays, type PvDayParams } from '../episodes/pv';
import { extractElStarts, extractElSteadyRuns, extractFcStarts, extractFcSteadyRuns, type StackExtractorParams, type StackNameplate } from '../episodes/stack-episodes';
import type { AssetSeries, TimeWindow } from '../types';
import { isExtractable } from './sources';
import type { PipelineAsset, StoredEpisode } from './types';

export class NameplateError extends Error {
  constructor(asset: PipelineAsset, field: string) {
    super(`설비 ${asset.code}(${asset.classKey}) 명판에 올바른 ${field} 값이 없습니다`);
    this.name = 'NameplateError';
  }
}

/** 명판의 양수 숫자 필드 (문자열 숫자도 허용). 없거나 0 이하면 NameplateError */
export function nameplateNumber(asset: PipelineAsset, field: string): number {
  const raw = asset.nameplate[field];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new NameplateError(asset, field);
  return value;
}

export interface ExtractorOverrides {
  readonly ess?: Partial<EssExtractorParams>;
  readonly pv?: Partial<PvDayParams>;
  readonly stack?: Partial<StackExtractorParams>;
}

function stackNameplate(asset: PipelineAsset): StackNameplate {
  return {
    cell_count: nameplateNumber(asset, 'cell_count'),
    active_area_cm2: nameplateNumber(asset, 'active_area_cm2'),
    rated_current_a: nameplateNumber(asset, 'rated_current_a'),
  };
}

/** [window.start, window.end) 원시 → 에피소드. 추출 대상 종류가 아니면 빈 배열 */
export function extractAssetEpisodes(asset: PipelineAsset, series: AssetSeries, window: TimeWindow, overrides: ExtractorOverrides = {}): StoredEpisode[] {
  if (!isExtractable(asset.classKey)) return [];
  const base = { assetId: asset.id, window, series };
  switch (asset.classKey) {
    case 'ess.rack': {
      const { charges, discharges, rests } = extractEssEpisodes({ ...base, nameplate: { capacity_ah: nameplateNumber(asset, 'capacity_ah') } }, overrides.ess);
      return [...charges, ...discharges, ...rests];
    }
    case 'pv.inverter':
      return extractPvDays({ ...base, nameplate: { ac_kw: nameplateNumber(asset, 'ac_kw'), dc_kwp: nameplateNumber(asset, 'dc_kwp') } }, overrides.pv);
    case 'h2.elz.stack': {
      const input = { ...base, nameplate: stackNameplate(asset) };
      return [...extractElSteadyRuns(input, overrides.stack), ...extractElStarts(input, overrides.stack)];
    }
    case 'fc.stack': {
      const input = { ...base, nameplate: stackNameplate(asset) };
      return [...extractFcSteadyRuns(input, overrides.stack), ...extractFcStarts(input, overrides.stack)];
    }
  }
}
