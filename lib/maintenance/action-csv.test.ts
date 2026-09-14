import { describe, expect, it } from 'vitest';
import { actionDuplicateKey, checkActionCsv, parseCsvDateTime, readActionCsv, type ActionCsvCatalog } from './action-csv';

const NOW = Date.UTC(2026, 8, 15);
const HEADER = 'site_code,asset_path,action_type,performed_at,performed_by,notes,finding_id';
const RACK03 = { id: 12, siteId: 1, classKey: 'ess.rack' };

const catalog = (overrides: Partial<ActionCsvCatalog> = {}): ActionCsvCatalog => ({
  sites: new Map([
    ['SIM-A', 1],
    ['SIM-B', 2],
  ]),
  assets: new Map([
    ['SIM-A/ESS1/RACK03', RACK03],
    ['SIM-A/PV1/INV01', { id: 20, siteId: 1, classKey: 'pv.inverter' }],
    ['SIM-B/ELZ1/STACK1', { id: 40, siteId: 2, classKey: 'h2.elz.stack' }],
  ]),
  findings: new Map([
    ['2', { siteId: 1, assetId: 12, status: 'triaged', detectorId: 'ess.cell_imbalance' }],
    ['3', { siteId: 1, assetId: 20, status: 'new', detectorId: 'pv.inverter_peer' }],
    ['8', { siteId: 1, assetId: 12, status: 'dismissed', detectorId: 'ess.cell_imbalance' }],
  ]),
  existing: new Set([actionDuplicateKey(12, '셀 밸런싱', Date.UTC(2026, 6, 31, 15))]),
  ...overrides,
});

const csv = (...lines: string[]): string => [HEADER, ...lines].join('\r\n');

describe('조치 CSV 검증', () => {
  it('정상 행: 사이트·설비·발견사항을 찾고 연결 발견사항의 탐지기 기본 검증 지표로 기대 효과를 채운다', () => {
    const result = checkActionCsv(csv('SIM-A,SIM-A/ESS1/RACK03,완충 유지로 밸런싱 시간 확보,2026-08-01 09:30,김정비,"메모, 쉼표 포함",2', 'SIM-A,SIM-A/PV1/INV01,팬 청소,2026-08-02,,,3'), catalog(), NOW);
    expect(result.errorCount).toBe(0);
    expect(result.rows).toEqual([
      { line: 2, siteId: 1, siteCode: 'SIM-A', assetId: 12, assetPath: 'SIM-A/ESS1/RACK03', actionType: '완충 유지로 밸런싱 시간 확보', performedAt: Date.UTC(2026, 7, 1, 0, 30), performedBy: '김정비', notes: '메모, 쉼표 포함', findingId: '2', expectedEffect: { metric: 'ess.cell_dv_mv', direction: 'decrease', min_delta: 0, stabilization_days: 3 } },
      { line: 3, siteId: 1, siteCode: 'SIM-A', assetId: 20, assetPath: 'SIM-A/PV1/INV01', actionType: '팬 청소', performedAt: Date.UTC(2026, 7, 1, 15), performedBy: null, notes: null, findingId: '3', expectedEffect: null },
    ]);
  });

  it('행별 오류를 줄 번호와 함께 모은다 (오류가 있으면 적용하지 않음)', () => {
    const result = checkActionCsv(
      csv(
        'SIM-X,SIM-A/ESS1/RACK03,점검,2026-08-01,,,',
        'SIM-A,SIM-B/ELZ1/STACK1,점검,2026-08-01,,,',
        'SIM-A,SIM-A/ESS1/RACK03,,2026-08-01,,,',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2026/08/01,,,',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2026-08-01,,,3',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2026-08-01,,,8',
        'SIM-A,SIM-A/ESS1/RACK03,셀 밸런싱,2026-08-01,,,',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2026-08-03,,,',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2026-08-03,,,',
        'SIM-A,SIM-A/ESS1/RACK03,점검',
        'SIM-A,SIM-A/ESS1/RACK03,점검,2028-01-01,,,',
      ),
      catalog(),
      NOW,
    );
    expect(result.errors.map((e) => [e.line, e.message])).toEqual([
      [2, 'site_code: 없는 사이트입니다 (SIM-X)'],
      [3, 'asset_path: SIM-A에 없는 설비입니다 (SIM-B/ELZ1/STACK1)'],
      [4, 'action_type: 조치 종류를 입력하세요'],
      [5, 'performed_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST)이어야 합니다'],
      [6, 'finding_id: 발견사항 3은(는) 다른 설비의 발견사항입니다'],
      [7, 'finding_id: 발견사항 8은(는) 닫혀 있습니다. 먼저 다시 여세요'],
      [8, '같은 설비·조치 종류·수행일시의 조치가 이미 등록되어 있습니다'],
      [10, '9행과 설비·조치 종류·수행일시가 겹칩니다'],
      [11, '열이 헤더와 같은 7개여야 합니다 (지금 3개)'],
      [12, 'performed_at: 예정일은 366일 이내여야 합니다'],
    ]);
    expect(result).toMatchObject({ errorCount: 10, dataRows: 11 });
    expect(result.rows).toHaveLength(1);
  });

  it('finding_id 열 없는 헤더도 받는다. 헤더가 틀리거나 데이터가 없으면 1행 오류', () => {
    const noFinding = checkActionCsv('site_code,asset_path,action_type,performed_at,performed_by,notes\nSIM-A,SIM-A/ESS1/RACK03,점검,2026-08-05,,', catalog(), NOW);
    expect(noFinding).toMatchObject({ errorCount: 0, rows: [{ findingId: null, expectedEffect: null }] });
    expect(checkActionCsv('site,asset\nSIM-A,x', catalog(), NOW).errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('첫 줄은 헤더') });
    expect(checkActionCsv(HEADER, catalog(), NOW).errors[0]?.message).toBe('헤더 아래에 데이터 행이 없습니다');
    expect(readActionCsv('"열리지 않은 따옴표').ok).toBe(false);
  });

  it('수행일시: 날짜만이면 KST 0시, 달력에 없는 날짜·시각은 거절', () => {
    expect(parseCsvDateTime('2026-08-01')).toBe(Date.UTC(2026, 6, 31, 15));
    expect(parseCsvDateTime('2026-08-01T23:59')).toBe(Date.UTC(2026, 7, 1, 14, 59));
    expect(parseCsvDateTime('2026-02-30')).toBeNull();
    expect(parseCsvDateTime('2026-08-01 24:00')).toBeNull();
  });
});
