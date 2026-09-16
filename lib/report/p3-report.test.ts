// P3 리포트: 탐지기 8종 메시지 템플릿 · 요약 맨 앞 '즉시 확인 필요'(안전 발견사항) · 에너지·수소 원장 절 · validateDraft 규칙.
import { describe, expect, it } from 'vitest';
import { URGENT_BLOCK_ID, type ReportDraft } from './composer';
import { buildEvidencePack, computePackHash, readStoredPack } from './evidence-pack';
import { MESSAGE_TEMPLATE_VERSION } from './messages';
import type { EvidencePack } from './pack-types';
import { setBlockInclusion, toReviewDraft } from './review';
import { templateComposer } from './template-composer';
import { KST_2026_09_01, packInput } from './test-fixtures';
import { blowerFinding, compFinding, elSecFinding, ledgerDay, massBalanceFinding, P3_FINDINGS, resistanceFinding, soilingFinding, tankFinding, thermalFinding } from './test-fixtures-p3';
import { validateDraft, type ValidatableDraft } from './validate';

const DAY = 86_400_000;
const textOf = (draft: ReportDraft, blockId: string): string => draft.sections.flatMap((s) => s.blocks).find((b) => b.id === blockId)?.text ?? '';
const codes = (result: ReturnType<typeof validateDraft>): string[] => result.issues.map((i) => i.code);

const p3Pack = (overrides: Parameters<typeof packInput>[0] = {}): EvidencePack =>
  buildEvidencePack(
    packInput({
      site: { id: 2, code: 'SIM-B', name: '새만금 연계형' },
      findings: P3_FINDINGS(),
      selection: { findingIds: ['10', '13', '9', '11', '12', '5', '4', '6'], includeVerifiedActions: false, basedOnReportId: null },
      verifications: [],
      ledgerDays: [ledgerDay('2026-09-01'), ledgerDay('2026-09-02', { h2_kg: { ...ledgerDay('2026-09-02').h2_kg, stored_delta: -20, residual: 1.2 } })],
      ...overrides,
    }),
  );

const withBlock = (draft: ReportDraft, blockId: string, change: (b: ValidatableDraft['sections'][number]['blocks'][number]) => ValidatableDraft['sections'][number]['blocks'][number]): ValidatableDraft => ({
  ...draft,
  sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => (b.id === blockId ? change(b) : b)) })),
});

describe('P3 탐지기 8종 메시지 템플릿', () => {
  const pack = p3Pack();
  const draft = templateComposer.compose(pack);

  it('저장용기 누설: 구간 수·온도 보정 질량 감소·95% CI·유의 기준·안전 기준과 현장 확인·교차 확인 신호·대체 불가 문구', () => {
    expect(textOf(draft, 'finding.10.message')).toBe(
      '[SIM-B/H2BANK1/TANK3] 저장용기 정지 보유 누설 (확정, 신뢰도 70%·탐지 3회): 정지 보유 구간 4개(길이 중앙값 9 h)의 온도 보정 질량(NIST 상태식)이 하루 1.03 kg(95% CI 0.95 ~ 1.12) 감소했습니다. 하루 저장량의 2.61%입니다. ' +
        '기준 구간 4개로 잰 센서 잡음 수준(σ 0.069 kg/일)의 유의 기준 0.13 kg/일을 넘습니다. 누설률 95% CI 하한이 안전 기준 0.5 kg/일을 넘는 안전 발견사항입니다. 가스 검지기 기록 확인과 누설 점검을 즉시 진행하고, 운전 정지 여부는 현장 안전책임자가 판단하세요. ' +
        '함께 확인된 신호: 뱅크 교차 확인 (같은 뱅크 다른 용기·압축기 토출 압력 대비). ' +
        '이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.',
    );
  });

  it('물질수지: 잔차율 중앙값·CI·기준 대비 방향·CUSUM 경보일·인증 산정 아님', () => {
    expect(textOf(draft, 'finding.13.message')).toBe(
      '[SIM-B] 수소 물질수지 잔차 (확정, 신뢰도 71%·탐지 3회): 최근 유효 6일의 일 잔차율 중앙값이 +2.28%(95% CI +2.27 ~ +2.35)로 기준 14일 중앙값 +0.02% 대비 증가했고, CUSUM 경보가 2026-08-16에 났습니다. 하루 약 1.04 kg이 계량으로 설명되지 않는 손실(또는 생산 과다 계량)입니다. ' +
        '함께 확인된 신호: 저장부 누설 의심 (정지 보유 누설률 교차 확인). 원장 할당·계량 추정 기반이며 청정수소 인증 공식 산정이 아닙니다.',
    );
  });

  it('같은 조건 상승 4종: 조건 bin·표본 수·기준 → 최근 수준·효과·CI·방향·추세 단위', () => {
    expect(textOf(draft, 'finding.9.message')).toContain('같은 조건(350~400 kW · 60~65 °C / 450~500 kW · 60~65 °C / 500~550 kW · 60~65 °C, 기준 30구간·최근 117구간)으로 비교하면 계통측 시스템 비에너지가 58.17 kWh/kg → 61.38 kWh/kg로 +5.5%(95% CI +5.1 ~ +6) 증가했습니다. 누적 운전시간 추세 +10.44 %/1000 h');
    expect(textOf(draft, 'finding.9.message')).toContain('함께 확인된 신호: 정류기 효율 저하.');
    expect(textOf(draft, 'finding.11.message')).toContain('압축기 비에너지가 1.973 kWh/kg → 2.131 kWh/kg로 +8%(95% CI +6.4 ~ +9.5) 증가했습니다.');
    expect(textOf(draft, 'finding.12.message')).toContain('블로워 비전력이 9.77 W/(kg/h) → 10.96 W/(kg/h)로 +12.1%(95% CI +7.2 ~ +21) 증가했습니다.');
    expect(textOf(draft, 'finding.5.message')).toContain('랙 직류 내부저항(R_60s)이 34.1 mΩ → 47 mΩ로 +37.8%(95% CI +11.2 ~ +73.1) 증가했습니다. 경과일 추세 +27.5 %/월');
  });

  it('오염(잠정): 오염 속도·누적 손실·방향·가격 없음 / 열 저감: 저감 일수·시간·손실률·같은 외기 비교', () => {
    expect(textOf(draft, 'finding.4.message')).toBe(
      '[SIM-B] 태양광 오염 손실 (잠정, 신뢰도 47%·탐지 2회): 맑은 날 11일의 온도 보정 성능지수로 보면 마지막 복원(2026-07-06 강우·복원(성능지수 급상승)) 이후 오염 속도 0.05%/일(95% CI 0.01 ~ 0.08)로 누적 손실이 약 3.7%(95% CI 0.8 ~ 5.6)까지 늘었습니다. ' +
        '누적 손실 약 4,114 kWh(최근 하루 약 127 kWh)로 추정됩니다. 가격 데이터가 없어 세척 경제성은 판단하지 않았습니다. 함께 확인된 신호: 사이트 전체 동시 저하 (오염 vs 일부 인버터), 일사계 자체 오염·드리프트 (GHI/POA 비율 변화), 복원 이벤트 후 회복 폭.',
    );
    expect(textOf(draft, 'finding.6.message')).toContain('방열판 65 °C 이상에서 동종 중앙값보다 5% 이상 낮은 열 저감이 2.5시간 있었고, 손실은 발전량 대비 0.52%(95% CI 0.19 ~ 0.87), 약 43 kWh입니다. 같은 외기 조건 일 저감 시간은 기준 0.18 h → 최근 0.22 h입니다.');
  });

  it('오염 경제성: SMP가 있으면 손실액·세척비 비율 문장 (세척비를 넘으면 세척 검토)', () => {
    const snapshot = soilingFinding().snapshot as Record<string, unknown>;
    const priced = p3Pack({ findings: [soilingFinding({ snapshot: { ...snapshot, smp_krw_per_kwh: 800 } })], selection: { findingIds: ['4'], includeVerifiedActions: false, basedOnReportId: null } });
    const text = textOf(templateComposer.compose(priced), 'finding.4.message');
    expect(text).toContain('SMP 800원/kWh 기준 손실액 약 3,291,360원으로 세척 1회 비용 3,000,000원의 110%입니다. 누적 손실액이 세척비를 넘었으니 세척을 검토하세요.');
  });

  it('탐지기별 최소 데이터 기간 미달이면 판정 보류(관찰 중), 만든 초안은 validateDraft를 통과한다', () => {
    const short = p3Pack({ findings: [elSecFinding({ windowStart: KST_2026_09_01, windowEnd: KST_2026_09_01 + 20 * DAY }), tankFinding()], selection: { findingIds: ['9', '10'], includeVerifiedActions: false, basedOnReportId: null } });
    const shortDraft = templateComposer.compose(short);
    expect(textOf(shortDraft, 'finding.9.message')).toBe('[SIM-B/ELZ1/STACK1] 전해조 시스템 비에너지 상승 — 판정 보류(관찰 중): 근거 데이터 기간이 최소 30일에 못 미칩니다(현재 20일). 데이터가 더 쌓인 뒤 분석을 다시 실행해 판정합니다.');
    expect(validateDraft(shortDraft, short)).toMatchObject({ ok: true, issues: [] });
    expect(validateDraft(draft, pack)).toMatchObject({ ok: true, issues: [] });
  });

  it('방향 단어 부호: 누설률(양수 = 질량 감소) "감소"를 "증가"로, 물질수지 "증가"를 "감소"로 바꾸면 direction_mismatch', () => {
    const tank = withBlock(draft, 'finding.10.message', (b) => ({ ...b, text: b.text.replace('감소했습니다.', '증가했습니다.') }));
    expect(codes(validateDraft(tank, pack))).toEqual(['direction_mismatch']);
    const balance = withBlock(draft, 'finding.13.message', (b) => ({ ...b, text: b.text.replace('대비 증가했고', '대비 감소했고') }));
    expect(codes(validateDraft(balance, pack))).toEqual(['direction_mismatch']);
    const negative = p3Pack({ findings: [massBalanceFinding({ effect: { metric: 'h2_residual_pct', value: -2.4, unit: '%', ciLow: -2.6, ciHigh: -2.2, baseline: 0.02, current: -2.4, levelUnit: '%' } })], selection: { findingIds: ['13'], includeVerifiedActions: false, basedOnReportId: null } });
    expect(textOf(templateComposer.compose(negative), 'finding.13.message')).toContain('−2.4%(95% CI −2.6 ~ −2.2)로 기준 14일 중앙값 +0.02% 대비 감소했고');
  });
});

describe("요약 맨 앞 '즉시 확인 필요' (안전 발견사항)", () => {
  const pack = p3Pack();
  const draft = templateComposer.compose(pack);

  it('안전 카테고리·심각도 4 이상만 요약 첫 블록에 모으고 고정 문구를 붙인다 (편집·제외 잠금)', () => {
    const summary = draft.sections.find((s) => s.kind === 'summary');
    expect(summary?.blocks[0]?.id).toBe(URGENT_BLOCK_ID);
    expect(summary?.blocks[0]?.citations).toEqual(['finding:10']);
    expect(textOf(draft, URGENT_BLOCK_ID)).toBe(
      '즉시 확인 필요: [SIM-B/H2BANK1/TANK3] 저장용기 정지 보유 누설 — 저장용기 누설 의심 1.03 kg/일 — 즉시 현장 확인(심각도 4). 가스 검지기 기록과 현장 점검을 먼저 확인하고, 운전 정지 여부는 현장 안전책임자가 판단하세요. 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.',
    );
    const review = toReviewDraft(draft);
    expect(review.sections[0]?.blocks[0]?.locked).toBe(true);
    expect(setBlockInclusion(review, URGENT_BLOCK_ID, false, '다음 달로', 'admin', 0)).toEqual({ ok: false, error: '고정 문구는 제외할 수 없습니다' });
    const noSafety = templateComposer.compose(p3Pack({ findings: [elSecFinding({ severity: 4 })], selection: { findingIds: ['9'], includeVerifiedActions: false, basedOnReportId: null } }));
    expect(textOf(noSafety, URGENT_BLOCK_ID)).toBe('');
  });

  it('즉시 확인 필요 블록이 없거나 인용·고정 문구가 빠지면 safety_urgent_missing', () => {
    const removed: ValidatableDraft = { ...draft, sections: draft.sections.map((s) => (s.kind === 'summary' ? { ...s, blocks: s.blocks.filter((b) => b.id !== URGENT_BLOCK_ID) } : s)) };
    const result = validateDraft(removed, pack);
    expect(codes(result)).toEqual(['safety_urgent_missing']);
    expect(result.issues[0]?.message).toContain('안전 발견사항 #10(SIM-B/H2BANK1/TANK3)');
    const uncited = withBlock(draft, URGENT_BLOCK_ID, (b) => ({ ...b, citations: [] }));
    expect(codes(validateDraft(uncited, pack))).toEqual(['safety_urgent_missing']);
    const noNotice = withBlock(draft, URGENT_BLOCK_ID, (b) => ({ ...b, text: b.text.replace(' 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.', '') }));
    expect(codes(validateDraft(noNotice, pack))).toEqual(['safety_urgent_missing']);
  });
});

describe('에너지·수소 원장 절', () => {
  const pack = p3Pack();
  const draft = templateComposer.compose(pack);

  it('KPI 뒤·안전 안내 앞, 기간 합 문장(원시·일 행 없음)과 원장 인용', () => {
    expect(draft.sections.map((s) => s.kind)).toEqual(['summary', 'todo', 'findings', 'data_quality', 'verified_actions', 'kpi', 'ledger', 'safety']);
    expect(textOf(draft, 'ledger.hydrogen')).toBe('수소 원장(2일 합): 생산 90 kg − 연료전지 소비 8 kg − 저장 증감 +19.5 kg − 배기 추정 1 kg = 잔차 +2.2 kg(잔차율 +2.44%).');
    expect(textOf(draft, 'ledger.kpi')).toBe('기간 합 체인 KPI: 전해조 비에너지 57.8 kWh/kg, 전해조 입력 전력 재생 비율 96%·계통전력 비율 4%, 연료전지 수소 원단위 66.7 kg/MWh, P2P 효율 25.1%.');
    expect(textOf(draft, 'ledger.energy')).toContain('pool_hourly@1 비례 할당 회계 흐름이며 실제 전기적 경로나 청정수소 인증 공식 산정이 아닙니다.');
    expect(textOf(draft, 'ledger.pv_loss')).toContain('출력제어 +240 kWh(+2.79%) · 클리핑 +80 kWh(+0.93%)');
    expect(draft.sections.find((s) => s.kind === 'ledger')?.blocks.every((b) => b.citations.includes('ledger'))).toBe(true);
    expect(JSON.stringify(pack.energyLedger)).not.toContain('flows_kwh');
    expect(pack.provenance).toMatchObject({ engineVersion: 'report-planner@2', templateVersion: MESSAGE_TEMPLATE_VERSION });
  });

  it('원장 수치 불일치: 토큰을 바꾸면 token_value, 본문 숫자만 바꾸면 untracked·missing', () => {
    const tokenChanged = withBlock(draft, 'ledger.hydrogen', (b) => ({ ...b, text: b.text.replace('생산 90 kg', '생산 95 kg'), numberTokens: b.numberTokens.map((t) => (t.path === 'energyLedger.hydrogen.producedKg' ? { ...t, text: '95' } : t)) }));
    expect(codes(validateDraft(tokenChanged, pack))).toEqual(['token_value']);
    const textChanged = withBlock(draft, 'ledger.kpi', (b) => ({ ...b, text: b.text.replace('57.8 kWh/kg', '55 kWh/kg') }));
    expect(codes(validateDraft(textChanged, pack))).toEqual(['untracked_number', 'missing_number']);
  });

  it('원장이 없으면 안내 블록, 원장·템플릿 버전이 없는 옛 팩도 해시 그대로 읽고 검증한다', () => {
    const empty = p3Pack({ ledgerDays: [] });
    expect(empty.energyLedger).toBeNull();
    expect(textOf(templateComposer.compose(empty), 'ledger.none')).toContain('저장된 체인 원장이 없습니다');
    const without = <T extends object>(value: T, key: string): T => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) as T;
    const rest = without(empty, 'energyLedger');
    const legacy: EvidencePack = { ...rest, provenance: { ...without(rest.provenance, 'templateVersion'), packHash: '' } };
    const hashed: EvidencePack = { ...legacy, provenance: { ...legacy.provenance, packHash: computePackHash(legacy) } };
    const stored = readStoredPack(JSON.parse(JSON.stringify(hashed)));
    expect(stored && computePackHash(stored)).toBe(hashed.provenance.packHash);
    expect(stored && validateDraft(templateComposer.compose(stored), stored).ok).toBe(true);
  });
});

describe('판정·우선순위 (P3)', () => {
  it('P3 탐지기 최소 데이터 기간·추정 영향이 반영된다', () => {
    const pack = p3Pack({ findings: [tankFinding(), compFinding(), blowerFinding(), resistanceFinding(), thermalFinding()], selection: { findingIds: ['10', '11', '12', '5', '6'], includeVerifiedActions: false, basedOnReportId: null } });
    expect(Object.fromEntries(pack.findings.map((f) => [f.id, f.minDataSpan?.value]))).toEqual({ '10': 14, '11': 30, '12': 30, '5': 30, '6': 30 });
    // 누설률 1.0328 ÷ 안전 기준 0.5 = 2.07 (상한 3) × 설비 중요도 4/3
    expect(pack.findings.find((f) => f.id === '10')?.impact).toBe(2.7541);
    expect(pack.todo[0]?.findingId).toBe('10');
  });
});
