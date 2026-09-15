import { describe, expect, it } from 'vitest';
import { DETECTORS, essCapacityFade, h2ChainMassBalanceGap, elSecRise } from '@/lib/analytics/detectors';
import { DETECTOR_TARGETING } from '@/lib/analytics/pipeline/targets';
import { paramFields } from './fields';
import { parseDetectorConfigForm } from './form';
import { configHistory, differsFromDefault, inputTextOf, paramsDiff, type ConfigVersionRow } from './history';
import { formatParamValue, scopeKindOf, scopeLabel } from './types';

const CAPACITY_FIELDS = paramFields(essCapacityFade.paramSchema);
const MASS_FIELDS = paramFields(h2ChainMassBalanceGap.paramSchema);

describe('paramSchema → 폼 필드', () => {
  it('정수·실수·불리언·null 가능·선택지 필드와 라벨·단위·범위·기본값을 읽는다', () => {
    const byKey = (key: string) => CAPACITY_FIELDS.find((f) => f.key === key);
    expect(byKey('referencePerBin')).toMatchObject({ kind: 'integer', nullable: false, label: 'bin별 기준 표본 수', defaultValue: 5 });
    expect(byKey('minCompleteness')).toMatchObject({ kind: 'number', min: 0, max: 1, defaultValue: 0.95 });
    expect(byKey('useRestAnchored')).toMatchObject({ kind: 'boolean', defaultValue: true, unit: '' });
    expect(byKey('referenceCurrentA')).toMatchObject({ kind: 'number', nullable: true, unit: 'A', min: 1, max: 10_000, defaultValue: null });
    expect(paramFields(elSecRise.paramSchema).find((f) => f.key === 'binBy')).toMatchObject({ kind: 'choice', options: ['ac_power', 'current_density'], defaultValue: 'ac_power' });
  });

  it('레지스트리 14종 모든 파라미터가 폼 필드가 되고 기본값이 defaultParams와 같다', () => {
    for (const detector of DETECTORS) {
      const fields = paramFields(detector.paramSchema);
      const defaults: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(detector.defaultParams));
      expect([detector.id, fields.map((f) => f.key).sort()]).toEqual([detector.id, Object.keys(defaults).sort()]);
      for (const field of fields) expect([detector.id, field.key, field.defaultValue]).toEqual([detector.id, field.key, defaults[field.key]]);
    }
  });
});

const parseCapacity = (values: Record<string, string>) =>
  parseDetectorConfigForm({ values, fields: CAPACITY_FIELDS, schema: essCapacityFade.paramSchema, defaultParams: essCapacityFade.defaultParams, targeting: DETECTOR_TARGETING['ess.capacity_fade'] });

describe('FormData 파싱', () => {
  it('빈 입력은 저장하지 않고, 입력한 값만 타입을 바꿔 저장한다 (null 체크·불리언·정수)', () => {
    const result = parseCapacity({ scopeKind: 'asset', assetId: '41', 'param.referencePerBin': ' 8 ', 'param.useCcAhFallback': 'false', 'param.referenceCurrentA.null': 'on', 'param.minCompleteness': '', refStart: '', refEnd: '' });
    expect(result).toEqual({ ok: true, input: { scopeKind: 'asset', scope: 'asset:41', assetId: 41, params: { referencePerBin: 8, useCcAhFallback: false, referenceCurrentA: null }, referenceWindow: null } });
    expect(parseCapacity({ scopeKind: 'class' })).toMatchObject({ ok: true, input: { scope: 'class:ess.rack', params: {} } });
  });

  it('범위 밖·정수 아님·숫자 아님·지수 표기·null 불가 필드를 거부한다', () => {
    const result = parseCapacity({ scopeKind: 'default', 'param.minCompleteness': '1.5', 'param.referencePerBin': '2.5', 'param.iterations': 'abc', 'param.sev2Pct': '1e-3', 'param.restMinutes.null': 'on' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors['param.minCompleteness']).toContain('0~1');
      expect(result.fieldErrors['param.referencePerBin']).toContain('정수');
      expect(result.fieldErrors['param.iterations']).toContain('숫자');
      expect(result.fieldErrors['param.sev2Pct']).toContain('지수');
      expect(result.fieldErrors['param.restMinutes']).toContain('비워 둘 수 없습니다');
    }
    expect(parseCapacity({ scopeKind: 'default', 'param.referenceCurrentA': '50', 'param.referenceCurrentA.null': 'on' })).toMatchObject({ ok: false, fieldErrors: { 'param.referenceCurrentA': expect.stringContaining('비워') } });
    expect(parseCapacity({ scopeKind: 'default', 'param.referenceCurrentA': '0.5' })).toMatchObject({ ok: false, fieldErrors: { 'param.referenceCurrentA': expect.stringContaining('1~10000 A') } });
  });

  it('적용되지 않는 범위·설비 미선택·기준 창 규칙', () => {
    const massTargeting = DETECTOR_TARGETING['h2chain.mass_balance_gap'];
    const parseMass = (values: Record<string, string>) => parseDetectorConfigForm({ values, fields: MASS_FIELDS, schema: h2ChainMassBalanceGap.paramSchema, defaultParams: h2ChainMassBalanceGap.defaultParams, targeting: massTargeting });
    expect(parseMass({ scopeKind: 'class' })).toMatchObject({ ok: false, fieldErrors: { scopeKind: expect.any(String) } });
    expect(parseMass({ scopeKind: 'default', 'param.residualPct': '3', refStart: '2026-06-01', refEnd: '2026-06-30' })).toEqual({
      ok: true,
      input: { scopeKind: 'default', scope: 'default', assetId: null, params: { residualPct: 3 }, referenceWindow: { startDay: '2026-06-01', endDay: '2026-06-30', startMs: Date.parse('2026-05-31T15:00:00Z'), endMs: Date.parse('2026-06-30T15:00:00Z') } },
    });
    expect(parseCapacity({ scopeKind: 'asset', assetId: '' })).toMatchObject({ ok: false, fieldErrors: { assetId: expect.any(String) } });
    expect(parseMass({ scopeKind: 'default', refStart: '2026-06-01' })).toMatchObject({ ok: false, fieldErrors: { refEnd: expect.any(String) } });
    expect(parseMass({ scopeKind: 'default', refStart: '2026-06-10', refEnd: '2026-06-01' })).toMatchObject({ ok: false, fieldErrors: { refEnd: expect.stringContaining('늦어야') } });
    expect(parseMass({ scopeKind: 'default', refStart: '2026-02-30', refEnd: '2026-03-02' })).toMatchObject({ ok: false, fieldErrors: { refStart: expect.any(String) } });
  });

  it('선택지 밖 값은 거부, 필드와 스키마가 어긋나도 스키마 재검증이 막는다', () => {
    const secFields = paramFields(elSecRise.paramSchema);
    const parseSec = (values: Record<string, string>, fields = secFields) => parseDetectorConfigForm({ values, fields, schema: elSecRise.paramSchema, defaultParams: elSecRise.defaultParams, targeting: DETECTOR_TARGETING['el.sec_rise'] });
    expect(parseSec({ scopeKind: 'default', 'param.binBy': 'voltage' })).toMatchObject({ ok: false, fieldErrors: { 'param.binBy': expect.stringContaining('목록') } });
    const loosened = secFields.map((f) => (f.key === 'recentDays' ? { ...f, max: null } : f));
    expect(parseSec({ scopeKind: 'default', 'param.recentDays': '999' }, loosened)).toMatchObject({ ok: false, fieldErrors: { 'param.recentDays': expect.stringContaining('스키마 검증 실패') } });
  });
});

describe('설정 이력·차이', () => {
  const row = (scope: string, version: number, params: Record<string, unknown>, active = false, referenceWindow: ConfigVersionRow['referenceWindow'] = null): ConfigVersionRow => ({ scope, version, params, referenceWindow, active, createdBy: 'a@b', createdAtMs: version });

  it('범위별 최신 버전부터, 바로 앞 버전 대비 추가·변경·삭제와 기준 창 변경', () => {
    const history = configHistory(
      [row('asset:9', 1, { residualPct: 3 }, true), row('default', 1, { residualPct: 3, recentDays: 7 }), row('default', 2, { residualPct: 2.5, minCompleteness: 0.8 }, true, { startDay: '2026-06-01', endDay: '2026-06-30' }), row('class:h2.elz', 1, {})],
      MASS_FIELDS,
    );
    expect(history.map((h) => [h.scope, h.active?.version ?? null])).toEqual([['default', 2], ['class:h2.elz', null], ['asset:9', 1]]);
    const latest = history[0]?.versions[0];
    expect(latest?.version).toBe(2);
    expect(latest?.windowChanged).toBe(true);
    expect(latest?.changes).toEqual([
      { key: 'residualPct', label: '잔차율 기준', change: 'changed', before: '3', after: '2.5' },
      { key: 'recentDays', label: '최근 기간', change: 'removed', before: '7', after: null },
      { key: 'minCompleteness', label: '최소 데이터 완결성', change: 'added', before: null, after: '0.8' },
    ]);
    expect(history[0]?.versions[1]?.changes.map((c) => c.change)).toEqual(['added', 'added']);
    expect(paramsDiff({ a: true }, { a: true, b: null }, [])).toEqual([{ key: 'b', label: 'b', change: 'added', before: null, after: '자동(비움)' }]);
  });

  it('기본값 대비 변경 강조 판정과 표시 문구', () => {
    const field = (key: string) => CAPACITY_FIELDS.find((f) => f.key === key) as (typeof CAPACITY_FIELDS)[number];
    expect(differsFromDefault(field('referencePerBin'), '5', false)).toBe(false);
    expect(differsFromDefault(field('referencePerBin'), '5.0', false)).toBe(false);
    expect(differsFromDefault(field('referencePerBin'), '6', false)).toBe(true);
    expect(differsFromDefault(field('referencePerBin'), '', false)).toBe(false);
    expect(differsFromDefault(field('useRestAnchored'), 'false', false)).toBe(true);
    expect(differsFromDefault(field('referenceCurrentA'), '', true)).toBe(false);
    expect(differsFromDefault(field('referenceCurrentA'), '40', false)).toBe(true);
    expect([inputTextOf(3), inputTextOf(false), inputTextOf(null), inputTextOf(undefined), inputTextOf({})]).toEqual(['3', 'false', '', '', '']);
    expect([formatParamValue(true), formatParamValue(null), formatParamValue('bins'), formatParamValue([1])]).toEqual(['켜기', '자동(비움)', 'bins', '[1]']);
    expect([scopeLabel('default'), scopeLabel('class:ess.rack'), scopeLabel('asset:7', 'SIM-A · ESS1/RACK01'), scopeLabel('asset:7')]).toEqual(['기본 (default)', '설비 종류 ess.rack', '설비 SIM-A · ESS1/RACK01', '설비 #7']);
    expect([scopeKindOf('default'), scopeKindOf('class:x'), scopeKindOf('asset:1'), scopeKindOf('zzz')]).toEqual(['default', 'class', 'asset', null]);
  });
});
