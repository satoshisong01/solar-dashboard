import { describe, expect, it } from 'vitest';
import { parseEffect } from './effect';
import { applyInboxFilter, compareInbox, DEFAULT_INBOX_FILTER, domainOfFinding, inboxSearch, parseInboxFilter, priorityOf, sortInbox, type InboxRow } from './inbox';

const row = (patch: Partial<InboxRow> & Pick<InboxRow, 'id'>): InboxRow => ({
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
  effect: parseEffect({}),
  firstDetectedMs: 1_000,
  lastDetectedMs: 2_000,
  detectionCount: 1,
  previousFindingId: null,
  ...patch,
});

describe('parseInboxFilter', () => {
  it('빈 쿼리는 기본값(열린 건 전체)', () => {
    expect(parseInboxFilter({})).toEqual(DEFAULT_INBOX_FILTER);
  });

  it('올바른 값은 그대로, 틀린 값은 기본값으로', () => {
    expect(parseInboxFilter({ site: 'SIM-B', domain: 'electrolyzer', category: 'degradation', severity: '3', status: 'triaged' })).toEqual({
      site: 'SIM-B',
      domain: 'electrolyzer',
      category: 'degradation',
      minSeverity: 3,
      status: 'triaged',
    });
    expect(parseInboxFilter({ site: '<script>', domain: 'wind', category: 'x', severity: '9', status: 'closed' })).toEqual(DEFAULT_INBOX_FILTER);
    expect(parseInboxFilter({ severity: '2.5' }).minSeverity).toBeNull();
    expect(parseInboxFilter({ status: 'all' }).status).toBe('all');
  });

  it('inboxSearch는 기본값이 아닌 항목만 쿼리에 남기고 다시 읽으면 같은 필터', () => {
    expect(inboxSearch(DEFAULT_INBOX_FILTER)).toBe('');
    const filter = parseInboxFilter({ site: 'SIM-A', domain: 'dq', severity: '4', status: 'all' });
    const search = inboxSearch(filter);
    expect(search).toBe('site=SIM-A&domain=dq&severity=4&status=all');
    expect(parseInboxFilter(Object.fromEntries(new URLSearchParams(search)))).toEqual(filter);
  });
});

describe('domainOfFinding', () => {
  it('데이터 품질 카테고리는 설비 종류와 관계없이 데이터품질 열', () => {
    expect(domainOfFinding({ category: 'data_quality', classKey: 'ess.rack' })).toBe('dq');
    expect(domainOfFinding({ category: 'degradation', classKey: 'h2.elz.stack' })).toBe('electrolyzer');
    expect(domainOfFinding({ category: 'performance', classKey: 'pv.inverter' })).toBe('pv');
    expect(domainOfFinding({ category: 'degradation', classKey: null })).toBeNull();
  });
});

describe('applyInboxFilter', () => {
  const rows = [
    row({ id: '1' }),
    row({ id: '2', siteCode: 'SIM-B', classKey: 'h2.elz.stack', detectorId: 'el.voltage_rise' }),
    row({ id: '3', status: 'dismissed' }),
    row({ id: '4', status: 'verified', severity: 4 }),
    row({ id: '5', category: 'data_quality', severity: 2, classKey: 'pv.inverter' }),
    row({ id: '6', status: 'action_taken', category: 'performance', classKey: 'pv.inverter', severity: 5 }),
  ];
  const ids = (filtered: readonly InboxRow[]) => filtered.map((r) => r.id);

  it('기본은 열린 건만 (기각·효과 확인 제외)', () => {
    expect(ids(applyInboxFilter(rows, DEFAULT_INBOX_FILTER))).toEqual(['1', '2', '5', '6']);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, status: 'all' }))).toHaveLength(6);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, status: 'dismissed' }))).toEqual(['3']);
  });

  it('사이트·도메인·카테고리·최소 심각도를 모두 만족해야 한다', () => {
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, site: 'SIM-B' }))).toEqual(['2']);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, domain: 'pv' }))).toEqual(['6']);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, domain: 'dq' }))).toEqual(['5']);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, category: 'degradation', minSeverity: 3 }))).toEqual(['1', '2']);
    expect(ids(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, minSeverity: 5, status: 'all' }))).toEqual(['6']);
  });
});

describe('sortInbox', () => {
  it('심각도×신뢰도가 큰 순서: 심각도가 낮아도 신뢰도가 높으면 앞선다', () => {
    const lowConfidenceSev4 = row({ id: '1', severity: 4, confidence: 0.5 }); // 2.0
    const highConfidenceSev3 = row({ id: '2', severity: 3, confidence: 0.9 }); // 2.7
    expect(priorityOf(highConfidenceSev3)).toBeCloseTo(2.7);
    expect(sortInbox([lowConfidenceSev4, highConfidenceSev3]).map((r) => r.id)).toEqual(['2', '1']);
  });

  it('점수가 같으면 심각도 → 최근 탐지 → id(숫자 크기) 내림차순', () => {
    const a = row({ id: '9', severity: 2, confidence: 1 }); // 2.0
    const b = row({ id: '10', severity: 4, confidence: 0.5 }); // 2.0, 심각도 높음
    const c = row({ id: '11', severity: 2, confidence: 1, lastDetectedMs: 5_000 });
    const d = row({ id: '100', severity: 2, confidence: 1 });
    expect(sortInbox([a, b, c, d]).map((r) => r.id)).toEqual(['10', '11', '100', '9']);
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const input = [row({ id: '1', severity: 1 }), row({ id: '2', severity: 5 })];
    const sorted = sortInbox(input);
    expect(input.map((r) => r.id)).toEqual(['1', '2']);
    expect(sorted.map((r) => r.id)).toEqual(['2', '1']);
    expect(compareInbox(input[0] as InboxRow, input[0] as InboxRow)).toBe(0);
  });
});
