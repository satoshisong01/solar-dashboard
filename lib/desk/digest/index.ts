// 분석 데스크 종합 요약 (순수, 서버·클라이언트 공용).
//   1) 몇 건인가  2) 어느 계통인가  3) 얼마나 급한가  4) 지금 할 일
// 세는 일은 stats.ts가, 문장으로 옮기는 일은 template.ts가 한다. AI는 이 문장을 다시 쓰기만 한다.
export { buildDigestStats, digestFingerprint, DIGEST_TOP_LIMIT, DOMAIN_LABELS, openFindingsFor, URGENCY_LABELS, urgencyOf } from './stats';
export { digestLabels, digestTemplate } from './template';
export type { DigestCount, DigestDomain, DigestGroup, DigestItem, DigestStats, DigestSummary, DigestUrgency, DigestUrgencyGroup } from './types';
