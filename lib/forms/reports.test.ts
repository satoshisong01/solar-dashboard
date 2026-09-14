import { describe, expect, it } from 'vitest';
import { parseDirectActionForm } from './maintenance';
import { parseBlockInclusionForm, parseBlockTextForm, parseCreateReportForm, periodSpecOf } from './reports';

const NOW = Date.UTC(2026, 8, 15);

describe('리포트 폼', () => {
  it('리포트 만들기: 사이트·월간 기간·발견사항(중복 제거)·검증된 조치 포함', () => {
    const result = parseCreateReportForm({ siteId: '2', kind: 'month', month: '2026-09', includeVerifiedActions: 'on' }, ['4', '5', '4']);
    expect(result).toMatchObject({ ok: true, input: { siteId: 2, findingIds: ['4', '5'], includeVerifiedActions: true, period: { kind: 'month', label: '2026년 9월' } } });
  });

  it('리포트 만들기 오류: 사이트 없음·분기 범위·잘못된 발견사항 id', () => {
    expect(parseCreateReportForm({ kind: 'quarter', year: '2026', quarter: '5' }, ['x'])).toEqual({ ok: false, fieldErrors: { siteId: '사이트를 고르세요', quarter: '분기를 고르세요', findingId: '발견사항이 올바르지 않습니다' } });
    expect(parseCreateReportForm({ siteId: '1' }, [])).toEqual({ ok: false, fieldErrors: { kind: '기간 종류를 고르세요' } });
    expect(periodSpecOf({ kind: 'custom', from: '2026-08-01', to: '2026-08-31' })).toEqual({ kind: 'custom', from: '2026-08-01', to: '2026-08-31' });
  });

  it('블록 편집·포함/제외: 제외면 사유 필수, 블록 id 형식', () => {
    expect(parseBlockTextForm({ reportId: '3', blockId: 'finding.12.message', text: ' 문장 ' })).toEqual({ ok: true, input: { reportId: '3', blockId: 'finding.12.message', text: '문장' } });
    expect(parseBlockTextForm({ reportId: '3', blockId: '<script>', text: 'x' })).toMatchObject({ ok: false, fieldErrors: { blockId: '블록이 올바르지 않습니다' } });
    expect(parseBlockInclusionForm({ reportId: '3', blockId: 'kpi.pv.kwh', included: '0', reason: '' })).toEqual({ ok: false, fieldErrors: { reason: '제외 사유를 입력하세요' } });
    expect(parseBlockInclusionForm({ reportId: '3', blockId: 'kpi.market.smp_land', included: '1', reason: '' })).toEqual({ ok: true, input: { reportId: '3', blockId: 'kpi.market.smp_land', included: true, reason: null } });
  });
});

describe('조치 직접 등록 폼', () => {
  const values = { siteId: '1', assetId: '12', findingId: '', actionType: '셀 밸런싱', performedAt: '2026-08-01T09:00', performedBy: '', notes: '', effectMetric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: '3', stabilizationDays: '3' };

  it('발견사항 연결은 선택, 기대 효과는 허용한 지표만', () => {
    expect(parseDirectActionForm(values, { nowMs: NOW, allowedMetrics: ['ess.cell_dv_mv'] })).toEqual({
      ok: true,
      input: { siteId: 1, assetId: 12, findingId: null, actionType: '셀 밸런싱', performedAt: new Date(Date.UTC(2026, 7, 1)), performedBy: null, notes: null, expectedEffect: { metric: 'ess.cell_dv_mv', direction: 'decrease', min_delta: 3, stabilization_days: 3 } },
    });
    expect(parseDirectActionForm({ ...values, findingId: 'abc', assetId: '' }, { nowMs: NOW, allowedMetrics: [] })).toEqual({ ok: false, fieldErrors: { effectMetric: '검증 지표가 올바르지 않습니다', assetId: '설비를 고르세요', findingId: '발견사항이 올바르지 않습니다' } });
  });
});
