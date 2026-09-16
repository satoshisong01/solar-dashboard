// 체인 원장 화면 이름. 순수 모듈 (서버·클라이언트 공용).
import type { DemandNode, PvLossBucket, SupplyNode } from '@/lib/analytics/ledger/types';

export const SUPPLY_LABELS: Readonly<Record<SupplyNode, string>> = {
  pv: '태양광',
  ess_discharge: 'ESS 방전',
  fc: '연료전지',
  grid_import: '계통 수전',
  unmetered: '미계측 공급',
};

export const DEMAND_LABELS: Readonly<Record<DemandNode, string>> = {
  site_aux: '보조부하',
  ess_charge: 'ESS 충전',
  electrolyzer: '전해조',
  compressor: '압축기',
  grid_export: '계통 송전',
  unmetered: '미계측 수요',
};

/** PV 미활용 원인 표시 순서와 이름 (원장 버킷 할당 순서와는 다르다: 할당은 lib/analytics/ledger/pv-loss.ts PV_LOSS_ORDER) */
export const PV_LOSS_DISPLAY: readonly (readonly [bucket: PvLossBucket, label: string])[] = [
  ['curtailment', '출력제어'],
  ['clipping', '클리핑'],
  ['outage', '정지'],
  ['derating', '열 저감'],
  ['ess_full', 'ESS 만충'],
  ['soiling_est', '오염 추정'],
  ['unexplained', '설명 안 됨'],
];

export const HYDROGEN_NODE_LABELS = {
  produced: '전해조 생산',
  delivered: '외부 반입',
  storageOut: '저장 인출',
  residualIn: '잔차(설명 안 된 유입)',
  fcConsumed: '연료전지 소비',
  storageIn: '저장 증가',
  vented: '배기 추정',
  residualOut: '잔차(설명 안 된 손실)',
} as const;

/** PV 손실 분해가 없는 날의 사유 코드 → 문구 */
export const PV_LOSS_REASON_LABELS: Readonly<Record<string, string>> = {
  no_inverter: '인버터 없음',
  no_poa: '일사계 없음',
  pr_ref_missing: '기준 PR 없음(맑은 날 부족)',
};

export const ALLOCATION_NOTE =
  'pool_hourly@1 비례 할당 가정: 한 시간 안의 전력은 섞인다고 보고, 매시 공급원 × 수요처 ÷ 풀 합계로 나눈 회계상 흐름입니다. 실제 전기적 경로가 아니며 청정수소 인증 공식 산정이 아닙니다.';
