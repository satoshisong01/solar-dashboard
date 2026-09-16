// 탐지기 레지스트리 → 준비도 요구 조건 (순수). 레지스트리 requires를 그대로 옮기고, 확보 순위 가중치용 대표 심각도는 카테고리로 정한다.
//   safety 4 (tank.static_leak은 누설률에 따라 3·4를 내지만 준비도에서는 안전 레인 우선) · degradation·performance·availability 3 · data_quality 2
import type { Detector, FindingCategory } from '../detectors/types';
import type { DetectorRequirement } from './types';

export const CATEGORY_SEVERITY: Readonly<Record<FindingCategory, number>> = { safety: 4, degradation: 3, performance: 3, availability: 3, data_quality: 2 };

type RegistryDetector = Pick<Detector<unknown, unknown>, 'id' | 'failureMode' | 'category' | 'requires'>;

export function requirementsFromDetectors(detectors: readonly RegistryDetector[]): DetectorRequirement[] {
  return detectors.map((d) => ({
    detectorId: d.id,
    failureMode: d.failureMode,
    assetClass: [...d.requires.assetClass],
    metrics: d.requires.metrics.map((m) => ({ ...m })),
    minHistoryDays: d.requires.minHistoryDays,
    severity: CATEGORY_SEVERITY[d.category],
  }));
}
