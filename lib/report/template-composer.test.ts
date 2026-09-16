import { describe, expect, it } from 'vitest';
import { SAFETY_NOTICE, type ReportDraft } from './composer';
import { buildEvidencePack } from './evidence-pack';
import { resolveReportPeriod } from './period';
import { templateComposer, TEMPLATE_COMPOSER_ID } from './template-composer';
import { capacityFinding, capacitySnapshot, cellFinding, KST_2026_09_01, packInput, pvFinding, stackFinding } from './test-fixtures';
import { validateDraft } from './validate';

const DAY = 86_400_000;
const textOf = (draft: ReportDraft, blockId: string): string => draft.sections.flatMap((s) => s.blocks).find((b) => b.id === blockId)?.text ?? '';

describe('templateComposer@1 섹션', () => {
  it('요약 → 할 일 → 발견사항 → 데이터 품질 → 검증된 조치 → KPI → 안전 순서, 팩 해시·composer id 기록', () => {
    const pack = buildEvidencePack(packInput());
    const draft = templateComposer.compose(pack);
    expect(draft.composerId).toBe(TEMPLATE_COMPOSER_ID);
    expect(draft.packHash).toBe(pack.provenance.packHash);
    expect(draft.sections.map((s) => s.kind)).toEqual(['summary', 'todo', 'findings', 'data_quality', 'verified_actions', 'kpi', 'ledger', 'safety']);
    expect(draft.sections[1]?.title).toBe('이번 달 할 일');
    expect(textOf(draft, 'safety.notice')).toBe(SAFETY_NOTICE);
    expect(textOf(draft, 'summary.overview')).toBe('SIM-A 2026-09-01 ~ 2026-09-30: 발견사항 5건(심각도 4 이상 1건, 판정 보류 0건), 조치 효과 검증 1건(개선 확인 1건).');
  });

  it('분기 리포트는 "이번 분기 할 일", 할 일은 심각도×신뢰도×추정 영향 상위 3개', () => {
    const quarter = resolveReportPeriod({ kind: 'quarter', year: 2026, quarter: 3 });
    if (!quarter.ok) throw new Error('period');
    const draft = templateComposer.compose(buildEvidencePack(packInput({ period: quarter.period })));
    const todo = draft.sections.find((s) => s.kind === 'todo');
    expect(todo?.title).toBe('이번 분기 할 일');
    expect(todo?.blocks.map((b) => b.text)).toEqual([
      '1. [SIM-B/ELZ1/STACK1] OCV 대기 최소화·램프율 제한 — 전해조 셀 전압 상승 +21.4 µV/h (심각도 4, 신뢰도 99%)',
      '2. [SIM-A/ESS1/RACK03] 완충 유지로 밸런싱 시간 확보 — 셀 전압 편차 증가 +23.7 mV (심각도 3, 신뢰도 98%)',
      '3. [SIM-A/ESS1/RACK01] 기준 조건 용량시험으로 감소 폭 확정 — 배터리 유효용량 감소 −7.4% (심각도 3, 신뢰도 85%)',
    ]);
  });

  it('발견사항이 없으면 빈 안내 블록을 둔다', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [], verifications: [], kpiRows: [], market: [] })));
    expect(textOf(draft, 'todo.none')).toBe('우선 조치할 발견사항이 없습니다.');
    expect(textOf(draft, 'findings.none')).toBe('이번 리포트에 포함한 발견사항이 없습니다.');
    expect(textOf(draft, 'kpi.none')).toContain('분석을 실행하면');
  });
});

describe('탐지기별 메시지 템플릿', () => {
  it('용량 감소: 같은 조건 문장·Ah·효과·95% CI·환산 충전시간·확정 표기', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [capacityFinding()] })));
    expect(textOf(draft, 'finding.1.message')).toBe(
      '[SIM-A/ESS1/RACK01] 배터리 유효용량 감소 (확정, 신뢰도 85%·탐지 3회): 같은 조건(충전전류 0.1~0.2C, 셀온도 20~25°C, SOC 변화 ≥ 40%인 부분 충전, 기준 20회·최근 12회)으로 충전을 비교하면 ' +
        '유효용량이 586.5 Ah → 543.1 Ah로 −7.4%(95% CI −7.5 ~ −7.2) 감소했습니다. 59 A 기준 환산 충전시간은 10h 00m → 9h 16m입니다. ' +
        '정격 대비 추세 −2.5%p/월(95% CI −2.72 ~ −2.29), SOH 80% 도달 추정 2027-05-01. 함께 확인된 신호: 셀 불균형으로 인한 조기 종료.',
    );
    expect(textOf(draft, 'finding.1.advice')).toBe('권고: 기준 조건 용량시험으로 감소 폭 확정; 셀 밸런싱 후 같은 조건으로 재평가. 기각 전 확인할 오탐 요인: 운영 SOC 상한 변경, 셀 불균형으로 인한 조기 종료.');
  });

  it('용량 감소(휴지 앵커): 방향 bin은 전류 범위 없이 휴지 규칙·쌍 수, SOC 기반 추정 주의 문구를 붙이고 validateDraft를 통과한다', () => {
    const snapshot = capacityFinding().snapshot as Record<string, unknown>;
    const rest = capacityFinding({
      effect: { metric: 'rest_anchored', value: -6.2, unit: '%', ciLow: -6.6, ciHigh: -5.8, baseline: 598.1, current: 561, levelUnit: 'Ah' },
      snapshot: {
        ...snapshot,
        metric: 'rest_anchored',
        cautions: ['soc_estimate_depends_on_bms_recalibration'],
        rest_pair_rules: { rest_minutes: 30, min_delta_soc_pct: 25, soc_sigma_pct: 1 },
        bins: [
          { key: 'chg|20', n_ref: 5, n_cur: 21, med_ref: 598.4, med_cur: 561.1, ratio: 0.9377, used: true, weight: 0.51 },
          { key: 'dis|20', n_ref: 5, n_cur: 20, med_ref: 597.8, med_cur: 560.9, ratio: 0.9383, used: true, weight: 0.49 },
        ],
      },
    });
    const pack = buildEvidencePack(packInput({ findings: [rest] }));
    const draft = templateComposer.compose(pack);
    const text = textOf(draft, 'finding.1.message');
    expect(text).toContain('같은 조건(셀온도 20~25°C, 30분 이상 휴지 끝 SOC 두 점, SOC 변화 ≥ 25%, 기준 10쌍·최근 41쌍)으로 휴지 앵커 사이 충방전을 비교하면 유효용량이 598.1 Ah → 561 Ah로 −6.2%');
    expect(text).toContain('주의: SOC 기반 용량 추정은 BMS SOC 재보정 품질에 의존합니다.');
    expect(validateDraft(draft, pack)).toMatchObject({ ok: true, issues: [] });
  });

  it('효과와 CI 경계가 표시상 같아지면 자릿수를 늘리고(최대 3자리), 데이터 기간이 짧은 SOH 도달일은 날짜 대신 추세 확인 중으로 쓴다', () => {
    const snapshot = capacityFinding().snapshot as Record<string, Record<string, unknown>>;
    const shortTrend = capacitySnapshot(40) as unknown as Record<string, Record<string, unknown>>;
    const narrow = capacityFinding({
      effect: { metric: 'capacity_ah_soc', value: -7.396, unit: '%', ciLow: -7.43, ciHigh: -7.38, baseline: 586.52, current: 543.14, levelUnit: 'Ah' },
      snapshot: { ...snapshot, trend: shortTrend.trend },
    });
    const pack = buildEvidencePack(packInput({ findings: [narrow] }));
    const draft = templateComposer.compose(pack);
    const text = textOf(draft, 'finding.1.message');
    expect(text).toContain('−7.4%(95% CI −7.43 ~ −7.38) 감소했습니다.');
    expect(text).toContain('SOH 80% 도달 시점은 추세 확인 중(데이터 39일).');
    expect(text).not.toContain('2027-05-01');
    expect(textOf(draft, 'todo.1')).toContain('배터리 유효용량 감소 −7.4%');
    expect(validateDraft(draft, pack)).toMatchObject({ ok: true, issues: [] });
  });

  it('잠정: 탐지 1회면 "잠정" 표기', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [pvFinding()] })));
    expect(textOf(draft, 'finding.3.message')).toBe(
      '[SIM-A/PV1/INV01] 인버터 동종 비교 (잠정, 신뢰도 73%·탐지 1회): 평가 7일 중 7일은 같은 사이트 동종 인버터(4대) 대비 kWh/kWp가 낮았습니다. 동종 중앙값 4.18 → 이 인버터 4.09 kWh/kWp, −2.05%(95% CI −2.07 ~ −2.04). 출력제한·클리핑·정지일 1일은 제외했습니다.',
    );
  });

  it('판정 보류: 최소 데이터 기간 미달이면 효과 수치 없이 관찰 중으로 쓰고 권고 블록을 두지 않는다', () => {
    const short = capacityFinding({ windowStart: KST_2026_09_01, windowEnd: KST_2026_09_01 + 12 * DAY });
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [short] })));
    const text = textOf(draft, 'finding.1.message');
    expect(text).toBe('[SIM-A/ESS1/RACK01] 배터리 유효용량 감소 — 판정 보류(관찰 중): 근거 데이터 기간이 최소 21일에 못 미칩니다(현재 12일). 데이터가 더 쌓인 뒤 분석을 다시 실행해 판정합니다.');
    expect(text).not.toContain('Ah');
    expect(textOf(draft, 'finding.1.advice')).toBe('');
  });

  it('스택 전압: 누적 운전시간 축 µV/h·CI·운전 구간 동안 변화', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [stackFinding()] })));
    expect(textOf(draft, 'finding.4.message')).toBe(
      '[SIM-B/ELZ1/STACK1] 전해조 셀 전압 상승 (확정, 신뢰도 99%·탐지 3회): break-in 1,000 h 이후 정상운전 240구간(누적 운전 1,020~1,950 h)을 같은 전류밀도·온도 구간 2개로 맞추면 셀 평균 전압이 21.4 µV/h(95% CI 20.7 ~ 22.2)로 상승하고 있습니다. 운전 930 h 동안 셀당 약 19.9 mV 상승.',
    );
  });

  it('스택 전압(변화점 이후 기울기): 변화점과 전체 구간 기울기를 함께 쓰고 validateDraft를 통과한다', () => {
    const snapshot = stackFinding().snapshot as Record<string, Record<string, unknown>>;
    const kinked = stackFinding({
      effect: { metric: 'v_cell_rise_rate', value: 24.6, unit: 'µV/h', ciLow: 23.8, ciHigh: 25.5, baseline: 1912.1, current: 1929.8, levelUnit: 'mV' },
      snapshot: {
        ...snapshot,
        trend: { ...snapshot.trend, basis: 'post_change', slope_uv_per_h: 24.6, ci_low_uv_per_h: 23.8, ci_high_uv_per_h: 25.5, full: { slope_uv_per_h: 21.4 }, change_start_op_h: 1230, line: [{ op_h: 1230, dv_mv: -2.1 }, { op_h: 1950, dv_mv: 15.6 }] },
      },
    });
    const pack = buildEvidencePack(packInput({ findings: [kinked] }));
    const draft = templateComposer.compose(pack);
    expect(textOf(draft, 'finding.4.message')).toContain('(누적 운전 1,230~1,950 h)');
    expect(textOf(draft, 'finding.4.message')).toContain('기울기가 바뀐 변화점(누적 1,230 h) 이후 구간의 값이며, 전체 구간 기울기는 21.4 µV/h입니다.');
    expect(validateDraft(draft, pack)).toMatchObject({ ok: true, issues: [] });
  });

  it('셀 편차: 기준 → 최근 mV·추세·동종 비교', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput({ findings: [cellFinding()] })));
    expect(textOf(draft, 'finding.2.message')).toContain('기준 8 mV(15회) → 최근 31.7 mV(20회)로 +23.7 mV(95% CI +22.8 ~ +25.6) 증가했습니다. 추세 +10.1 mV/월(95% CI +9.4 ~ +10.9). 동종 랙 3대 대비 수정 z 5.2.');
  });

  it('데이터 품질·검증된 조치·KPI 문장', () => {
    const draft = templateComposer.compose(buildEvidencePack(packInput()));
    expect(textOf(draft, 'dq.7.message')).toBe('[SIM-A/PV1/INV02] 데이터 결측·고착: 수신 결측 포인트 1개(완결성 최저 91.2%, 결측 최대 6시간), 값 고착 포인트 1개(최장 12.5시간). 게이트웨이·통신 경로 점검과 센서 교정·배선 점검을 요청합니다.');
    expect(textOf(draft, 'dq.completeness.1')).toBe('[SIM-A/PV1/INV02] 태양광 발전량 데이터 완결성 90%(3일) — 기준 95%에 못 미칩니다. 통신·계측 경로 점검을 요청합니다.');
    expect(textOf(draft, 'action.9')).toBe('[SIM-A/ESS1/RACK03] 조치 "완충 유지로 밸런싱 시간 확보"(수행 2026-07-23): 충전 종료 셀 전압 편차 −6.2 mV(95% CI −7.1 ~ −5.3, 전 12회·후 11회 비교) → 개선 확인.');
    const kpi = draft.sections.find((s) => s.kind === 'kpi');
    expect(kpi?.blocks.map((b) => b.text)).toEqual(['태양광 발전량 합계 12,030 kWh(3일, 일평균 4,010 kWh), 데이터 완결성 99%.', 'ESS 왕복효율 평균 90.6%, 설비별 90~91.2%(2대, 최대 3일), 데이터 완결성 100%.', 'SMP (육지) 기간 평균 142.3 원/kWh(2일 입력, 140.1~144.5).']);
  });

  it('표본 방식이 여럿인 지표(용량)는 어떤 방식으로 비교했는지 밝힌다, 옛 검증 행은 방식 없이 그대로', () => {
    const verification = {
      id: '11',
      actionId: '6',
      findingId: null,
      assetPath: 'SIM-A/ESS1/RACK01',
      actionType: '랙 교체',
      performedAt: KST_2026_09_01 - 40 * DAY,
      verdict: 'improved' as const,
      effect: 20,
      ciLow: 12.5,
      ciHigh: 27.1,
      beforeStats: { metric: 'ess.capacity_ah', unit: 'Ah', method: 'rest_anchored', n: 10, bins: [] },
      afterStats: { method: 'rest_anchored', n: 10, bins: [] },
      computedAt: KST_2026_09_01 + 13 * DAY,
    };
    const pack = buildEvidencePack(packInput({ verifications: [verification] }));
    expect(pack.verifiedActions[0]).toMatchObject({ metric: 'ess.capacity_ah', method: 'rest_anchored', methodLabel: '휴지 앵커' });
    const draft = templateComposer.compose(pack);
    expect(textOf(draft, 'action.11')).toBe('[SIM-A/ESS1/RACK01] 조치 "랙 교체"(수행 2026-07-23): 랙 유효용량 +20 Ah(95% CI +12.5 ~ +27.1, 전 10회·후 10회 비교) → 개선 확인. 표본 방식: 휴지 앵커.');
    expect(validateDraft(draft, pack)).toMatchObject({ ok: true, issues: [] });

    // report-planner@2 이전 검증 행(방식 없음)은 기본 방식으로 보고 문장에 방식을 붙이지 않는다
    const legacy = buildEvidencePack(packInput({ verifications: [{ ...verification, beforeStats: { metric: 'ess.capacity_ah', unit: 'Ah', n: 10, bins: [] }, afterStats: { n: 10, bins: [] } }] }));
    expect(legacy.verifiedActions[0]).toMatchObject({ method: 'episode', methodLabel: '에피소드 값' });
    expect(textOf(templateComposer.compose(legacy), 'action.11')).not.toContain('표본 방식');
  });

  it('만든 초안은 validateDraft를 통과한다', () => {
    const pack = buildEvidencePack(packInput());
    expect(validateDraft(templateComposer.compose(pack), pack)).toMatchObject({ ok: true, issues: [] });
  });
});
