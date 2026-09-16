// 탐지기별 판정 단위와 설정 적용 범위 (순수). detect.ts·detect-p3.ts의 runOne 호출(configTarget·assetId)과 같게 유지한다
// (targets.test.ts가 실제 실행 결과의 적용 설정 목록으로 확인한다).
//   findingUnit  asset = finding이 설비에 붙는다 · site = 사이트 단위(asset_id NULL)
//   targetClass  판정 대상 설비 종류 (null = 모든 설비 또는 사이트 전체). 탐지 준비도 매트릭스의 행 선택에 쓴다
//   configClass  class:<종류> 범위 설정이 적용되는 설비 종류 (null = default 범위만)
//   assetScope   asset:<id> 범위 설정이 적용되는지 (id는 configClass 설비)
// 설정 UI는 이 표로 범위 선택지를 만든다: 적용되지 않는 범위에 설정을 저장하면 분석에서 조용히 무시되기 때문이다.
import type { PipelineDetectorId } from './detect-common';

export interface DetectorTargeting {
  readonly findingUnit: 'asset' | 'site';
  readonly targetClass: string | null;
  readonly configClass: string | null;
  readonly assetScope: boolean;
}

const perAsset = (classKey: string): DetectorTargeting => ({ findingUnit: 'asset', targetClass: classKey, configClass: classKey, assetScope: true });

export const DETECTOR_TARGETING: Readonly<Record<PipelineDetectorId, DetectorTargeting>> = Object.freeze({
  // 사이트 포인트 요약을 한 번에 판정하고 finding은 포인트의 설비에 붙는다
  'dq.gap_flatline': { findingUnit: 'asset', targetClass: null, configClass: null, assetScope: false },
  'ess.capacity_fade': perAsset('ess.rack'),
  'ess.cell_imbalance': perAsset('ess.rack'),
  // 동종 인버터 그룹 한 번 실행 (설정은 인버터 종류 범위까지)
  'pv.inverter_peer': { findingUnit: 'asset', targetClass: 'pv.inverter', configClass: 'pv.inverter', assetScope: false },
  'el.voltage_rise': perAsset('h2.elz.stack'),
  'fc.voltage_decay': perAsset('fc.stack'),
  'el.sec_rise': perAsset('h2.elz.stack'),
  'tank.static_leak': perAsset('h2.storage.tank'),
  'comp.sec_rise': perAsset('h2.compressor'),
  'fc.blower_wear': perAsset('fc.blower'),
  // 발전소 설비(pv.plant)가 있으면 그 설비 범위 설정까지 적용, finding은 사이트 단위
  'pv.soiling_rate': { findingUnit: 'site', targetClass: null, configClass: 'pv.plant', assetScope: true },
  'ess.resistance_growth': perAsset('ess.rack'),
  'inv.thermal_derating': { findingUnit: 'asset', targetClass: 'pv.inverter', configClass: 'pv.inverter', assetScope: false },
  'h2chain.mass_balance_gap': { findingUnit: 'site', targetClass: null, configClass: null, assetScope: false },
  'prv.seat_leak': perAsset('h2.prv'),
  'hx.fouling': perAsset('hx.recovery'),
  'o2.purity_drift': perAsset('o2.plant'),
});

const isPipelineDetectorId = (id: string): id is PipelineDetectorId => Object.hasOwn(DETECTOR_TARGETING, id);

/** 레지스트리에 없는 탐지기면 null */
export const targetingOf = (detectorId: string): DetectorTargeting | null => (isPipelineDetectorId(detectorId) ? DETECTOR_TARGETING[detectorId] : null);

/** 설정을 저장할 수 있는 범위 종류: default는 항상, class·asset은 표에 따라 */
export function allowedScopeKinds(targeting: DetectorTargeting): readonly ('default' | 'class' | 'asset')[] {
  return ['default', ...(targeting.configClass === null ? [] : (['class'] as const)), ...(targeting.configClass !== null && targeting.assetScope ? (['asset'] as const) : [])];
}
