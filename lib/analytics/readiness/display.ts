// 준비도 매트릭스 셀·요약 표시 규칙 (순수, 화면·CSV 공용 문구). 상태는 색만으로 구분하지 않는다: 아이콘·짧은 글자·툴팁 문장을 함께 준다.
//   ready → 정상 톤 · 체크 아이콘 · '준비'      partial → 주의 톤 · 삼각 경고 · '부분'
//   missing → 위험 톤 · X 아이콘 · '없음'       n/a → 흐린 톤 · 빈 원 · '—'
// 툴팁(title·스크린리더 문장) = 탐지기 이름 · 상태 설명 · 누락 필수 메트릭 · 누락 권장 메트릭 · 부족 사유(missing 셀도 있는 메트릭 사유는 참고로 붙인다).
// 권장 메트릭은 상태를 낮추지 않으므로 ready 셀에도 붙는다 — 확보하면 판별 체크가 늘어난다는 안내다.
import { reasonText, STATUS_LABELS } from './csv';
import type { MetricAcquisition, ReadinessCell, ReadinessStatus, ReadinessSummary } from './types';

export type CellTone = 'ok' | 'warn' | 'crit' | 'na';
export type CellIcon = 'check' | 'alert' | 'cross' | 'dash';

export interface CellDisplay {
  readonly status: ReadinessStatus;
  readonly tone: CellTone;
  readonly icon: CellIcon;
  /** 셀 안에 보이는 짧은 글자 */
  readonly short: string;
  /** 없는 권장 메트릭 (상태와 무관, ready 셀에도 붙는다). 비어 있지 않으면 화면에 '*' 표시를 단다 */
  readonly recommendedMissing: readonly string[];
  /** 툴팁·스크린리더 문장 (줄바꿈으로 구분) */
  readonly tooltip: string;
}

/** 권장 메트릭 표시 문구 (화면·툴팁 공용) */
export const RECOMMENDED_LABEL = '권장 메트릭 없음';

const STATUS_STYLE: Readonly<Record<ReadinessStatus, Pick<CellDisplay, 'tone' | 'icon' | 'short'>>> = {
  ready: { tone: 'ok', icon: 'check', short: '준비' },
  partial: { tone: 'warn', icon: 'alert', short: '부분' },
  missing: { tone: 'crit', icon: 'cross', short: '없음' },
  'n/a': { tone: 'na', icon: 'dash', short: '—' },
};

/** 셀 표시. detectorName은 화면 이름(없으면 탐지기 id) */
export function cellDisplay(cell: ReadinessCell, detectorName: string = cell.detectorId): CellDisplay {
  const lines = [
    `${cell.assetCode} · ${detectorName}: ${STATUS_LABELS[cell.status]}`,
    ...(cell.missingMetrics.length > 0 ? [`누락 메트릭: ${cell.missingMetrics.join(', ')}`] : []),
    ...(cell.recommendedMissing.length > 0 ? [`${RECOMMENDED_LABEL}: ${cell.recommendedMissing.join(', ')} (없어도 판정은 하지만 판별 체크가 줄어듭니다)`] : []),
    ...cell.reasons.map((reason) => `사유: ${reasonText(reason)}`),
    ...(cell.status === 'n/a' ? ['이 설비 종류에는 적용하지 않는 탐지기입니다'] : []),
  ];
  return { status: cell.status, ...STATUS_STYLE[cell.status], recommendedMissing: cell.recommendedMissing, tooltip: lines.join('\n') };
}

/** ready 비율 문구: '9 / 12 (75%)', 적용 셀이 없으면 '적용 셀 없음' */
export function readyRatioText(summary: ReadinessSummary): string {
  if (summary.readyRatio === null) return '적용 셀 없음';
  return `${summary.ready} / ${summary.applicable} (${Math.round(summary.readyRatio * 100)}%)`;
}

export interface AcquisitionView extends MetricAcquisition {
  /** 이 메트릭이 누락 목록에 있는 셀의 탐지기 (중복 없이 셀 순서) */
  readonly detectorIds: readonly string[];
}

/** 확보 순위에 관련 탐지기를 붙인다 */
export function withRelatedDetectors(ranking: readonly MetricAcquisition[], cells: readonly ReadinessCell[]): AcquisitionView[] {
  return ranking.map((r) => ({
    ...r,
    detectorIds: [...new Set(cells.filter((c) => c.status === 'missing' && c.missingMetrics.includes(r.metricKey)).map((c) => c.detectorId))],
  }));
}
