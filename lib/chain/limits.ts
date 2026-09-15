// 체인 원장 화면 상수. 순수 모듈.

/** 사용자 지정 조회 기간 상한 [일] (분석 실행 기간 상한 MAX_ANALYSIS_DAYS와 같은 값) */
export const MAX_CHAIN_DAYS = 400;

/** 원장 품질 경고: 원천 완결성이 이 값 미만인 날 (h2chain.mass_balance_gap 기본 minCompleteness와 같은 값) */
export const LEDGER_MIN_COMPLETENESS = 0.9;

/**
 * 원장 품질 경고: 계측 불일치율(unmetered kWh ÷ 풀 kWh)이 이 값 초과 (기간 합·일별 모두 이 기준).
 * 추정 기준 — 개발 DB 데모 3사이트 120일에서 기간 불일치율 약 0.1%, 일별 p95 약 0.5%·최대 1.5%라 그 두 배 위로 두었다. 현장 계량점 구성이 정해지면 다시 정한다.
 */
export const LEDGER_MAX_UNMETERED_RATIO = 0.03;
