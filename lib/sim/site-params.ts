// 사이트 명판 → 물리 모델 파라미터 (플랜트 조립과 고장 크기 보정이 같은 값을 쓴다).
import type { SiteDef } from '@/db/seed/types';
import { electrolyzerParams, type ElectrolyzerParams } from './models/electrolyzer';
import { nameplateNumber, singleAsset } from './plant-types';

export function electrolyzerParamsOf(site: SiteDef): ElectrolyzerParams {
  const stack = singleAsset(site, 'h2.elz.stack');
  const elz = singleAsset(site, 'h2.elz');
  return electrolyzerParams({
    cellCount: nameplateNumber(stack, 'cell_count'),
    activeAreaCm2: nameplateNumber(stack, 'active_area_cm2'),
    ratedCurrentA: nameplateNumber(stack, 'rated_current_a'),
    ratedAcKw: nameplateNumber(elz, 'rated_kw'),
    rectifierRatedDcKw: nameplateNumber(singleAsset(site, 'h2.elz.rectifier'), 'rated_dc_kw'),
    outletBar: nameplateNumber(elz, 'outlet_bar'),
    // PEM 턴다운. 명판에 없으면 모델 기본값(0.2)을 쓴다
    minLoadFraction: typeof elz.nameplate.min_load_fraction === 'number' ? elz.nameplate.min_load_fraction : undefined,
  });
}
