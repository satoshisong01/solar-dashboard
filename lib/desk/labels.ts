// 분석 데스크 표시 문구. 순수 모듈 (서버·클라이언트 공용, zod·DB 없음).
import type { CheckStatus, FindingCategory } from '@/lib/analytics/detectors/types';
import { OPERATING_CONDITION_CHANGE } from '@/lib/analysis/transition-rules';

export const FINDING_CATEGORIES: readonly FindingCategory[] = ['degradation', 'performance', 'data_quality', 'safety', 'availability'];

export const CATEGORY_LABELS: Readonly<Record<FindingCategory, string>> = {
  degradation: '열화',
  performance: '성능',
  data_quality: '데이터 품질',
  safety: '안전',
  availability: '가용성',
};

export const isFindingCategory = (value: string): value is FindingCategory => (FINDING_CATEGORIES as readonly string[]).includes(value);

/** 탐지기 id → 짧은 이름. 모르는 탐지기는 id 그대로 */
const DETECTOR_LABELS: Readonly<Record<string, string>> = {
  'ess.capacity_fade': '배터리 유효용량 감소',
  'ess.cell_imbalance': '셀 전압 편차 증가',
  'pv.inverter_peer': '인버터 동종 비교',
  'el.voltage_rise': '전해조 셀 전압 상승',
  'fc.voltage_decay': '연료전지 셀 전압 감소',
  'dq.gap_flatline': '데이터 결측·고착',
  'el.sec_rise': '전해조 시스템 비에너지 상승',
  'h2chain.mass_balance_gap': '수소 물질수지 잔차',
  'tank.static_leak': '저장용기 정지 보유 누설',
  'comp.sec_rise': '압축기 비에너지 상승',
  'fc.blower_wear': '연료전지 블로워 비전력 증가',
  'pv.soiling_rate': '태양광 오염 손실',
  'ess.resistance_growth': '배터리 랙 내부저항 증가',
  'inv.thermal_derating': '인버터 열 출력저감',
};

export function detectorLabel(detectorId: string): string {
  return DETECTOR_LABELS[detectorId] ?? detectorId;
}

export const SEVERITY_LEVELS = [1, 2, 3, 4, 5] as const;

const SEVERITY_NAMES: readonly string[] = ['', '관찰', '낮음', '보통', '높음', '긴급'];

/** 심각도 1~5 → '3 · 보통' */
export function severityLabel(severity: number): string {
  const name = SEVERITY_NAMES[severity];
  return name ? `${severity} · ${name}` : String(severity);
}

export const CHECK_STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  supports: '지지',
  refutes: '반박',
  unknown: '불명',
  no_data: '데이터 없음',
};

/** 기각 사유 선택지. 첫 항목(운영 조건 변경)만 기준선 분할을 함께 만들 수 있다 */
export const DISMISS_REASONS: readonly string[] = [OPERATING_CONDITION_CHANGE, '센서·데이터 문제', '계획된 정비·시험', '근거 부족(오탐)', '기타'];

export const DEFAULT_SUPPRESS_DAYS = 30;
export const MAX_SUPPRESS_DAYS = 365;

export const VERDICT_LABELS: Readonly<Record<string, string>> = {
  improved: '개선 확인',
  no_change: '변화 없음',
  worse: '악화',
  insufficient_data: '데이터 부족',
};

export const verdictLabel = (verdict: string): string => VERDICT_LABELS[verdict] ?? verdict;

/** 근거 주의 코드 → 문구 (화면·리포트 공용) */
export const CAUTION_LABELS: Readonly<Record<string, string>> = {
  soc_estimate_depends_on_bms_recalibration: 'SOC 기반 용량 추정은 BMS SOC 재보정 품질에 의존합니다. BMS 교정·펌웨어 변경 이력과 함께 보세요.',
};

export const cautionLabel = (code: string): string => CAUTION_LABELS[code] ?? code;
