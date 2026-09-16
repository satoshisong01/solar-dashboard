// 준비도 매트릭스·메트릭 확보 순위 CSV (순수). 헤더는 "한국어 (영문 키)" 병기.
// 규칙: RFC 4180 — 쉼표·큰따옴표·줄바꿈이 있으면 큰따옴표로 감싸고 "는 ""로 적는다. 줄 구분 CRLF.
//       문자열이 = + - @ 탭·CR로 시작하면 엑셀 수식으로 실행되지 않게 앞에 '를 붙인다(CSV 인젝션 방지). 숫자 값은 그대로 둔다.
//       파일 앞에 UTF-8 BOM을 붙여 엑셀에서 한글이 깨지지 않게 한다 (lib/csv/parse.ts는 BOM을 버린다).
import type { MetricAcquisition, PartialReason, ReadinessCell, ReadinessStatus } from './types';

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export type CsvValue = string | number | null;

export function csvField(value: CsvValue): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const csvLine = (values: readonly CsvValue[]): string => values.map(csvField).join(',');

export const toCsvText = (rows: readonly (readonly CsvValue[])[]): string => BOM + rows.map(csvLine).join('\r\n') + '\r\n';

export const STATUS_LABELS: Readonly<Record<ReadinessStatus, string>> = {
  ready: '준비됨',
  partial: '부분 준비',
  missing: '필수 메트릭 없음',
  'n/a': '해당 없음',
};

const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;

export function reasonText(reason: PartialReason): string {
  switch (reason.code) {
    case 'low_completeness':
      return `${reason.metricKey} 완결성 ${reason.completeness === null ? '데이터 없음' : percent(reason.completeness)} (기준 ${percent(reason.required)} 이상)`;
    case 'coarse_period':
      return `${reason.metricKey} 주기 ${reason.periodS}초 (기준 ${reason.requiredS}초 이하)`;
    case 'short_history':
      return `이력 ${reason.historyDays}일 (기준 ${reason.requiredDays}일 이상)`;
  }
}

export const READINESS_CSV_HEADER: readonly string[] = [
  '설비 경로 (asset_code)',
  '설비 종류 (asset_class)',
  '탐지기 (detector_id)',
  '고장모드 (failure_mode)',
  '심각도 (severity)',
  '상태 (status)',
  '상태 설명 (status_label)',
  '누락 필수 메트릭 (missing_metrics)',
  '누락 권장 메트릭 (recommended_missing)',
  '부족 사유 (reasons)',
];

/** 헤더 + 셀마다 한 행. 목록 값은 '; '로 잇는다 */
export function readinessCsvRows(cells: readonly ReadinessCell[]): CsvValue[][] {
  return [
    [...READINESS_CSV_HEADER],
    ...cells.map((c) => [
      c.assetCode,
      c.assetClass,
      c.detectorId,
      c.failureMode,
      c.severity,
      c.status,
      STATUS_LABELS[c.status],
      c.missingMetrics.join('; '),
      c.recommendedMissing.join('; '),
      c.reasons.map(reasonText).join('; '),
    ]),
  ];
}

export const ACQUISITION_CSV_HEADER: readonly string[] = [
  '순위 (rank)',
  '메트릭 (metric_key)',
  '확보 시 풀리는 셀 (unlocks)',
  '심각도 가중 (severity_weight)',
  '관련 누락 셀 (blocked_cells)',
];

export function acquisitionCsvRows(ranking: readonly MetricAcquisition[]): CsvValue[][] {
  return [[...ACQUISITION_CSV_HEADER], ...ranking.map((r, i) => [i + 1, r.metricKey, r.unlocks, r.severityWeight, r.blockedCells])];
}
