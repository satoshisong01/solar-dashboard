// 종합 요약 테스트 공용 입력 (순수). 집계 테스트와 문장 생성 검증 테스트가 같은 묶음을 쓴다.
import { parseEffect } from '../effect';
import type { InboxRow } from '../inbox';

export const digestRow = (patch: Partial<InboxRow> & Pick<InboxRow, 'id'>): InboxRow => ({
  siteCode: 'SIM-A',
  siteName: '영암',
  assetId: 10,
  assetPath: 'SIM-A/ESS1/RACK01',
  assetName: '랙 1',
  classKey: 'ess.rack',
  detectorId: 'ess.capacity_fade',
  category: 'degradation',
  severity: 3,
  confidence: 0.8,
  status: 'new',
  title: '제목',
  effect: parseEffect({ metric: 'capacity_fade_pct', value: -7.3, unit: '%' }),
  firstDetectedMs: 1_000,
  lastDetectedMs: 2_000,
  detectionCount: 1,
  previousFindingId: null,
  ...patch,
});

/** 열린 건 5 (배터리 3·전해조 1·데이터 품질 1) + 닫힌 건 1 + 다른 사이트 1 */
export const DIGEST_ROWS: readonly InboxRow[] = [
  digestRow({ id: '1', severity: 5, confidence: 0.9 }),
  digestRow({ id: '2', severity: 3 }),
  digestRow({ id: '3', severity: 1, status: 'reopened' }),
  digestRow({ id: '4', severity: 4, classKey: 'h2.elz.stack', detectorId: 'el.voltage_rise', assetName: '전해 스택', assetPath: 'SIM-A/ELZ1/STACK1' }),
  digestRow({ id: '5', severity: 2, category: 'data_quality', detectorId: 'dq.gap_flatline' }),
  digestRow({ id: '6', severity: 5, status: 'dismissed' }),
  digestRow({ id: '7', severity: 4, siteCode: 'SIM-B', siteName: '새만금' }),
];
