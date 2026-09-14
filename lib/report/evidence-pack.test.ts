import { describe, expect, it } from 'vitest';
import { buildEvidencePack, computePackHash, readStoredPack } from './evidence-pack';
import { evidencePointCount } from './pack-evidence';
import { MAX_EVIDENCE_POINTS } from './pack-types';
import { capacityFinding, GENERATED_AT, KST_2026_09_01, packInput, pvFinding, stackFinding } from './test-fixtures';

const DAY = 86_400_000;

describe('buildEvidencePack 해시 결정성', () => {
  it('generatedAt만 다르면 팩 해시가 같다', () => {
    const a = buildEvidencePack(packInput());
    const b = buildEvidencePack(packInput({ generatedAt: GENERATED_AT + 3_600_000 }));
    expect(a.provenance.packHash).toMatch(/^[0-9a-f]{32}$/);
    expect(b.provenance.packHash).toBe(a.provenance.packHash);
    expect(b.provenance.generatedAt).not.toBe(a.provenance.generatedAt);
  });

  it('발견사항·KPI·검증 행의 입력 순서가 달라도 같은 해시', () => {
    const input = packInput();
    const shuffled = packInput({ findings: [...input.findings].reverse(), kpiRows: [...input.kpiRows].reverse(), market: [...input.market].reverse(), selection: { ...input.selection, findingIds: [...input.selection.findingIds].reverse() } });
    expect(buildEvidencePack(shuffled).provenance.packHash).toBe(buildEvidencePack(input).provenance.packHash);
  });

  it('수치가 하나라도 바뀌면 해시가 바뀐다', () => {
    const changed = packInput({ findings: [capacityFinding({ severity: 4 }), stackFinding()] });
    const original = packInput({ findings: [capacityFinding(), stackFinding()] });
    expect(buildEvidencePack(changed).provenance.packHash).not.toBe(buildEvidencePack(original).provenance.packHash);
  });

  it('JSON 저장 뒤 다시 읽어도 해시가 같다 (jsonb 왕복)', () => {
    const pack = buildEvidencePack(packInput());
    const stored = readStoredPack(JSON.parse(JSON.stringify(pack)));
    expect(stored).not.toBeNull();
    expect(computePackHash(stored ?? pack)).toBe(pack.provenance.packHash);
    expect(readStoredPack({ schema: 'other' })).toBeNull();
  });
});

describe('buildEvidencePack 내용', () => {
  it('원시 시계열을 넣지 않는다: 근거 요약 시계열은 120점 이하', () => {
    const long = capacityFinding({ snapshot: { ...(capacityFinding().snapshot as object), trend: { ...((capacityFinding().snapshot as { trend: object }).trend), points: Array.from({ length: 500 }, (_, i) => ({ t: KST_2026_09_01 + i * 3_600_000, soh_pct: 97 - i * 0.01 })) } } });
    const pack = buildEvidencePack(packInput({ findings: [long] }));
    const finding = pack.findings[0];
    expect(finding && evidencePointCount(finding.evidence)).toBe(MAX_EVIDENCE_POINTS);
    expect(JSON.stringify(pack)).not.toContain('overlay');
  });

  it('발견사항은 심각도 → 우선순위 순, 할 일은 판정 보류·데이터 품질을 뺀 상위 3개', () => {
    const pack = buildEvidencePack(packInput());
    expect(pack.findings.map((f) => f.id)).toEqual(['4', '2', '1', '7', '3']);
    expect(pack.todo.map((t) => [t.rank, t.findingId])).toEqual([
      [1, '4'],
      [2, '2'],
      [3, '1'],
    ]);
    expect(pack.todo[0]?.action).toBe('OCV 대기 최소화·램프율 제한');
    expect(pack.stats).toMatchObject({ findingCount: 5, severeThreshold: 4, severeCount: 1, holdCount: 0, verifiedActionCount: 1, improvedCount: 1 });
  });

  it('판정: 반복 탐지·신뢰도 충분하면 확정, 1회면 잠정, 최소 데이터 기간 미달이면 판정 보류', () => {
    const pack = buildEvidencePack(
      packInput({
        findings: [capacityFinding(), capacityFinding({ id: '11', detectionCount: 1 }), capacityFinding({ id: '12', windowStart: KST_2026_09_01, windowEnd: KST_2026_09_01 + 10 * DAY }), stackFinding({ id: '13', snapshot: { method: 'binned_residual_theil_sen', bins: [], trend: { points: [{ op_h: 1000, dv_mv: 0 }], line: [{ op_h: 1000, dv_mv: 0 }, { op_h: 1100, dv_mv: 2 }] } } })],
      }),
    );
    const byId = new Map(pack.findings.map((f) => [f.id, f]));
    expect(byId.get('1')?.judgement).toBe('confirmed');
    expect(byId.get('11')?.judgement).toBe('provisional');
    expect(byId.get('12')).toMatchObject({ judgement: 'hold', dataSpan: { value: 10, unit: 'days' }, minDataSpan: { value: 21, unit: 'days' } });
    expect(byId.get('13')).toMatchObject({ judgement: 'hold', dataSpan: { value: 100, unit: 'op_hours' } });
    expect(pack.todo.map((t) => t.findingId)).not.toContain('12');
  });

  it('추정 영향은 효과 크기와 설비 중요도에 비례한다', () => {
    const pack = buildEvidencePack(packInput({ findings: [pvFinding({ assetCriticality: 3 }), pvFinding({ id: '21', assetCriticality: 5 })] }));
    const [critical, normal] = [pack.findings.find((f) => f.id === '21'), pack.findings.find((f) => f.id === '3')];
    expect(critical?.impact).toBeCloseTo((normal?.impact ?? 0) * (5 / 3), 3);
    expect(critical?.priority).toBeGreaterThan(normal?.priority ?? 0);
  });

  it('KPI: 사이트 발전량 합계, 설비 비율 지표는 % 환산, 완결성 95% 미만 설비는 데이터 품질 요청', () => {
    const pack = buildEvidencePack(packInput());
    expect(pack.kpis.find((k) => k.key === 'pv.kwh')).toMatchObject({ scope: 'site', total: 12030, mean: 4010, days: 3, completenessPct: 99 });
    expect(pack.kpis.find((k) => k.key === 'ess.rte')).toMatchObject({ scope: 'assets', unit: '%', assetCount: 2, mean: 90.6, min: 90, max: 91.2 });
    expect(pack.dataQuality).toEqual({ completenessThresholdPct: 95, lowCompleteness: [{ key: 'pv.kwh', label: '태양광 발전량', assetPath: 'SIM-A/PV1/INV02', completenessPct: 90, days: 3 }], findingIds: ['7'] });
    expect(pack.revenueSummary).toEqual([{ key: 'smp_land', label: 'SMP (육지)', unit: '원/kWh', days: 2, mean: 142.3, min: 140.1, max: 144.5 }]);
  });

  it('검증된 조치를 포함하지 않으면 비운다', () => {
    const pack = buildEvidencePack(packInput({ selection: { findingIds: ['1'], includeVerifiedActions: false, basedOnReportId: null } }));
    expect(pack.verifiedActions).toEqual([]);
    expect(pack.stats.verifiedActionCount).toBe(0);
  });

  it('용량 근거: 사용 bin 범위·환산 충전시간·SOH 도달 추정을 요약한다', () => {
    const pack = buildEvidencePack(packInput({ findings: [capacityFinding()] }));
    expect(pack.findings[0]?.evidence).toMatchObject({ kind: 'capacity', nRef: 20, nCur: 12, cRateLow: 0.1, cRateHigh: 0.2, tempLowC: 20, tempHighC: 25, referenceCurrentA: 58.7, slopePerMonth: -2.5, sohTargetPct: 80 });
    const evidence = pack.findings[0]?.evidence;
    expect(evidence?.kind === 'capacity' ? evidence.baselineHours : null).toBeCloseTo(586.52 / 58.65, 3);
  });
});
