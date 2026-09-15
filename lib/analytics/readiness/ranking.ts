// 메트릭 확보 순위 (순수): 벤더·게이트웨이와 데이터 계약을 협의할 때 "무엇부터 받아야 하나"의 근거.
//   unlocks        = 이 메트릭 하나만 없어서 missing인 (설비 × 탐지기) 셀 수. 확보하면 ready 또는 partial로 풀린다
//                    (새 포인트의 완결성·주기는 아직 모르므로 둘을 구분하지 않는다).
//   severityWeight = unlocks 셀의 고장모드 심각도 합
//   blockedCells   = 이 메트릭이 누락 목록에 있는 missing 셀 수 (다른 메트릭과 함께 없어도 센다)
// 정렬: unlocks 내림차순 → severityWeight 내림차순 → blockedCells 내림차순 → 메트릭 키 오름차순.
import type { MetricAcquisition, ReadinessCell } from './types';

const compareKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function metricAcquisitionRanking(cells: readonly ReadinessCell[]): MetricAcquisition[] {
  const tallies = new Map<string, MetricAcquisition>(); // 이 함수 안에서만 누적한다
  for (const cell of cells) {
    if (cell.status !== 'missing') continue;
    const single = cell.missingMetrics.length === 1;
    for (const metricKey of new Set(cell.missingMetrics)) {
      const t = tallies.get(metricKey) ?? { metricKey, unlocks: 0, severityWeight: 0, blockedCells: 0 };
      tallies.set(metricKey, {
        metricKey,
        unlocks: t.unlocks + (single ? 1 : 0),
        severityWeight: t.severityWeight + (single ? cell.severity : 0),
        blockedCells: t.blockedCells + 1,
      });
    }
  }
  return [...tallies.values()].sort(
    (a, b) => b.unlocks - a.unlocks || b.severityWeight - a.severityWeight || b.blockedCells - a.blockedCells || compareKey(a.metricKey, b.metricKey),
  );
}
