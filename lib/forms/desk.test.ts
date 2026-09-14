import { describe, expect, it } from 'vitest';
import { parseActionForm, parseDismissForm, parseFindingIds, parseRunForm } from './desk';

const NOW = Date.parse('2026-09-14T18:00:00Z'); // 2026-09-15 03:00 KST
const DAY = 86_400_000;

describe('parseRunForm', () => {
  it('최근 N일: 끝은 지금, 사이트·설비 중복은 한 번만', () => {
    const result = parseRunForm({ values: { period: '120' }, siteIds: ['1', '3', '1'], assetIds: [], nowMs: NOW });
    expect(result).toEqual({ ok: true, input: { siteIds: [1, 3], assetIds: undefined, from: new Date(NOW - 120 * DAY), to: new Date(NOW) } });
    const withAssets = parseRunForm({ values: { period: '30' }, siteIds: ['2'], assetIds: ['40', '41', '40'], nowMs: NOW });
    expect(withAssets.ok && withAssets.input.assetIds).toEqual([40, 41]);
  });

  it('사용자 지정: KST 입력을 UTC로, 끝이 미래면 지금으로 맞춘다', () => {
    const result = parseRunForm({ values: { period: 'custom', from: '2026-08-01T00:00', to: '2026-09-30T00:00' }, siteIds: ['1'], assetIds: [], nowMs: NOW });
    expect(result).toEqual({ ok: true, input: { siteIds: [1], assetIds: undefined, from: new Date('2026-07-31T15:00:00Z'), to: new Date(NOW) } });
  });

  it('사이트 없음·기간 없음·역전·400일 초과는 필드 오류', () => {
    expect(parseRunForm({ values: { period: '30' }, siteIds: [], assetIds: [], nowMs: NOW })).toEqual({ ok: false, fieldErrors: { siteIds: '사이트를 하나 이상 고르세요' } });
    expect(parseRunForm({ values: { period: '7' }, siteIds: ['1'], assetIds: [], nowMs: NOW })).toEqual({ ok: false, fieldErrors: { period: '기간을 고르세요' } });
    expect(parseRunForm({ values: { period: 'custom', from: '2026-09-10T00:00', to: '2026-09-01T00:00' }, siteIds: ['1'], assetIds: [], nowMs: NOW })).toMatchObject({ ok: false, fieldErrors: { to: expect.stringContaining('늦고') } });
    expect(parseRunForm({ values: { period: 'custom', from: '2025-01-01T00:00', to: '2026-09-01T00:00' }, siteIds: ['1'], assetIds: [], nowMs: NOW })).toMatchObject({ ok: false, fieldErrors: { from: '분석 기간은 400일 이하여야 합니다' } });
    expect(parseRunForm({ values: { period: 'custom', from: '', to: '' }, siteIds: ['1'], assetIds: [], nowMs: NOW })).toMatchObject({ ok: false, fieldErrors: { from: '시작 시각을 입력하세요', to: '끝 시각을 입력하세요' } });
    expect(parseRunForm({ values: { period: '30' }, siteIds: ['x'], assetIds: [], nowMs: NOW }).ok).toBe(false);
  });
});

describe('parseFindingIds', () => {
  it('bigint id만, 중복 제거', () => {
    expect(parseFindingIds(['3', '1', '3'])).toEqual({ ok: true, input: ['3', '1'] });
    expect(parseFindingIds([])).toEqual({ ok: false, fieldErrors: { findingId: '발견사항을 하나 이상 고르세요' } });
    expect(parseFindingIds(['1', '0']).ok).toBe(false);
    expect(parseFindingIds(Array.from({ length: 201 }, (_, i) => String(i + 1))).ok).toBe(false);
  });
});

describe('parseDismissForm', () => {
  it('사유·메모·억제 기간(빈 값이면 30일)', () => {
    expect(parseDismissForm({ reason: '센서·데이터 문제', note: ' ', suppressDays: '' }, NOW)).toEqual({ ok: true, input: { reason: '센서·데이터 문제', note: null, suppressDays: 30, resetBaselineAt: null } });
    expect(parseDismissForm({ reason: '근거 부족(오탐)', suppressDays: '0' }, NOW).ok).toBe(true);
  });

  it('운영 조건 변경 + 기준선 분할: 발생 시점이 필요하고 지금 이전이어야 한다', () => {
    expect(parseDismissForm({ reason: '운영 조건 변경', resetBaseline: 'on', baselineAt: '2026-08-20T09:00' }, NOW)).toEqual({
      ok: true,
      input: { reason: '운영 조건 변경', note: null, suppressDays: 30, resetBaselineAt: new Date('2026-08-20T00:00:00Z') },
    });
    expect(parseDismissForm({ reason: '운영 조건 변경', resetBaseline: 'on', baselineAt: '' }, NOW)).toMatchObject({ ok: false, fieldErrors: { baselineAt: '운영 조건이 바뀐 시점을 입력하세요' } });
    expect(parseDismissForm({ reason: '운영 조건 변경', resetBaseline: 'on', baselineAt: '2026-09-16T00:00' }, NOW)).toMatchObject({ ok: false, fieldErrors: { baselineAt: '바뀐 시점은 지금 이전이어야 합니다' } });
  });

  it('다른 사유로 기준선 분할을 체크하면 오류, 사유 누락·기타 메모 누락·억제 기간 범위', () => {
    expect(parseDismissForm({ reason: '기타', resetBaseline: 'on', baselineAt: '2026-08-20T09:00' }, NOW)).toMatchObject({ ok: false, fieldErrors: { note: expect.any(String), resetBaseline: expect.stringContaining('운영 조건 변경') } });
    expect(parseDismissForm({ reason: '' }, NOW)).toMatchObject({ ok: false, fieldErrors: { reason: '기각 사유를 고르세요' } });
    expect(parseDismissForm({ reason: '센서·데이터 문제', suppressDays: '400' }, NOW)).toMatchObject({ ok: false, fieldErrors: { suppressDays: expect.any(String) } });
  });
});

describe('parseActionForm', () => {
  const allowedMetrics = ['ess.capacity_ah', 'ess.cell_dv_mv'];
  const base = { findingId: '12', actionType: ' 셀 밸런싱 ', performedAt: '2026-09-20T10:00', performedBy: '', notes: '' };

  it('수행일은 예정(미래)도 받고, 기대 효과는 지표를 고르면 모든 항목이 필요하다', () => {
    const result = parseActionForm({ ...base, effectMetric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: '5', stabilizationDays: '3' }, { nowMs: NOW, allowedMetrics });
    expect(result).toEqual({
      ok: true,
      input: { findingId: '12', actionType: '셀 밸런싱', performedAt: new Date('2026-09-20T01:00:00Z'), performedBy: null, notes: null, expectedEffect: { metric: 'ess.cell_dv_mv', direction: 'decrease', min_delta: 5, stabilization_days: 3 } },
    });
    expect(parseActionForm({ ...base, effectMetric: '' }, { nowMs: NOW, allowedMetrics })).toMatchObject({ ok: true, input: { expectedEffect: null } });
  });

  it('필드 오류: 조치 종류·수행일·지표·방향·최소 변화량·안정화 일수', () => {
    const result = parseActionForm({ findingId: '12', actionType: '', performedAt: '', effectMetric: 'el.unknown', direction: 'up', minDelta: '-1', stabilizationDays: '120' }, { nowMs: NOW, allowedMetrics });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { actionType: '조치 종류를 입력하세요', performedAt: '수행일시를 입력하세요', effectMetric: expect.any(String), direction: expect.any(String), minDelta: expect.any(String), stabilizationDays: expect.any(String) },
    });
    expect(parseActionForm({ ...base, performedAt: '2028-01-01T00:00', effectMetric: '' }, { nowMs: NOW, allowedMetrics })).toMatchObject({ ok: false, fieldErrors: { performedAt: expect.stringContaining('366일') } });
  });
});
