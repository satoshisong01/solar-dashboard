// 탐지 준비도 매트릭스 (설계 §4 /data/readiness, P3). 순수 모듈 — 포인트 수집 통계 로드는 lib/data/readiness.ts.
export { ACQUISITION_CSV_HEADER, acquisitionCsvRows, csvField, csvLine, READINESS_CSV_HEADER, readinessCsvRows, reasonText, STATUS_LABELS, toCsvText, type CsvValue } from './csv';
export { cellDisplay, readyRatioText, withRelatedDetectors, type AcquisitionView, type CellDisplay, type CellIcon, type CellTone } from './display';
export { appliesTo, readinessCell, readinessMatrix, readinessSummary } from './matrix';
export { metricAcquisitionRanking } from './ranking';
export { CATEGORY_SEVERITY, requirementsFromDetectors } from './registry';
export { pointStatOf, READINESS_EXTRA_SOURCES, relatedPoints, SITE_ROW_CLASS, SITE_ROW_CODE, SITE_ROW_ID, siteReadinessRows, type PointCounts, type ReadinessRow, type SitePointStat } from './site';
export * from './types';
