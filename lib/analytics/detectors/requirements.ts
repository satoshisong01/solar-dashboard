// 탐지기 `requires.metrics` 선언 도우미 (순수). 메트릭마다 주기 상한을 따로 적는다.
//
// 주기 상한을 고르는 규칙 — 그 메트릭이 판정에 기여하는 가장 빠른 현상의 시간상수로 정한다.
//   FAST_S  60초  전기적 순시값(스택·랙 전압·전류, 셀 전압). 전류 계단·CV 전이·전류밀도 bin이 샘플 간격 안에서 바뀐다.
//   SLOW_S 300초  적산값·온도·압력·상태·누적 카운터. 5분 간격으로도 일 적산 오차와 bin 배정이 달라지지 않는다.
// 데이터 계약 협의 자료(부록 A)가 이 값을 그대로 옮기므로, 실제로 필요한 것보다 짧게 적지 않는다.
import type { RequiredMetric } from './types';

/** 전기적 순시값 주기 상한 [s] */
export const FAST_S = 60;
/** 적산·온도·압력·상태 주기 상한 [s] */
export const SLOW_S = 300;

/** 필수 메트릭: 없으면 준비도 missing */
export const required = (key: string, maxPeriodS: number | null): RequiredMetric => ({ key, maxPeriodS });

/** 권장 메트릭: 없어도 ready. 판별 체크·조건 bin·보조 축이 줄어든다 */
export const recommended = (key: string, maxPeriodS: number | null): RequiredMetric => ({ key, maxPeriodS, optional: true });

/** 화면·CSV 표기: 'stack.current ≤60초' · 'purge.count ≤300초 (권장)' */
export const metricRequirementText = (metric: RequiredMetric): string =>
  `${metric.key} ${metric.maxPeriodS === null ? '주기 무관' : `≤${metric.maxPeriodS}초`}${metric.optional === true ? ' (권장)' : ''}`;
