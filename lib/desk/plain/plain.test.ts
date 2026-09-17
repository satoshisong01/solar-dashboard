// 쉬운 말 요약: 탐지기 14종 각각 실제 근거로 4줄이 나오는지, 반올림 규칙, 판정 보류 문구.
import { describe, expect, it } from 'vitest';
import { DETECTORS } from '@/lib/analytics/detectors';
import { MS_PER_DAY } from '@/lib/analytics/types';
import { plainSummary } from './index';
import { limitMarginText, plainOutlook, uaChangeText } from './outlook';
import { hasBatchim, severityAction, subjectText, withParticle } from './common';
import { PLAIN_HEADLINE_DETECTORS, plainHeadline } from './headline';
import { holdReasonOf } from './hold';
import { plainCases, type PlainCase } from './test-fixtures';
import type { GapyeongEvidence } from '../p3-evidence-types';

const CASES = plainCases();
const caseOf = (detectorId: string): PlainCase => {
  const found = CASES.find((item) => item.detectorId === detectorId);
  if (!found) throw new Error(`픽스처가 없습니다: ${detectorId}`);
  return found;
};
const summaryOf = (detectorId: string) => {
  const { finding, evidence } = caseOf(detectorId);
  return plainSummary(finding, evidence);
};

/** 현장 담당자가 모르는 말 — 1~3번 문장에 남아 있으면 안 된다 (4번은 플레이북 점검 항목 원문이라 뺀다) */
const JARGON = ['비에너지', '물질수지', '수정 z', '신뢰구간', '95% CI', 'CUSUM', 'Theil', '유효용량', '완결성', '심각도', '판정 보류', 'SOH', 'SOC', 'DOD', 'C-rate', '고착', '성능지수', '외삽'];
/** C-rate는 약어가 아니라 '0.10~0.20C'처럼 숫자 뒤 C로 나타난다 (°C는 앞이 숫자가 아니라 걸리지 않는다) */
const C_RATE_NOTATION = /\d\s*C(?![a-zA-Z])/;

describe('쉬운 말 요약 (탐지기 17종)', () => {
  it('탐지기 17종 전부 한 줄 요약 문장을 가진다', () => {
    expect([...PLAIN_HEADLINE_DETECTORS].sort()).toEqual(DETECTORS.map((detector) => detector.id).sort());
    expect(CASES.map((item) => item.detectorId).sort()).toEqual(DETECTORS.map((detector) => detector.id).sort());
  });

  it.each(CASES.map((item) => item.detectorId))('%s: 4줄이 모두 나오고 원래 제목으로 되돌아가지 않는다', (detectorId) => {
    const { finding } = caseOf(detectorId);
    const summary = summaryOf(detectorId);
    expect(summary.hold).toBe(false);
    expect(summary.what).not.toContain(finding.title);
    expect(summary.what.endsWith('.')).toBe(true);
    for (const line of [summary.basis, summary.outlook, summary.nextStep]) {
      expect(line).not.toBeNull();
      expect((line ?? '').length).toBeGreaterThan(5);
    }
  });

  it.each(CASES.map((item) => item.detectorId))('%s: 1~3번 문장에 전문 용어가 남지 않는다', (detectorId) => {
    const summary = summaryOf(detectorId);
    const text = [summary.what, summary.basis, summary.outlook].join(' ');
    expect(JARGON.filter((word) => text.includes(word))).toEqual([]);
    expect(C_RATE_NOTATION.test(text)).toBe(false);
  });

  it('ess.capacity_fade: 담기는 전기 감소 + 같은 조건 + 충전시간 영향', () => {
    const summary = summaryOf('ess.capacity_fade');
    expect(summary.what).toMatch(/^배터리 랙 1\(RACK01\)에 담기는 전기의 양이 처음 재던 때보다 \d+\.\d% 줄었습니다\.$/);
    expect(summary.basis).toMatch(/^한 시간에 [\d.]+~[\d.]+%씩 채우는 충전 속도와 셀 온도 .+처럼 조건이 비슷했던 때끼리만 골라 예전 \d+번, 최근 \d+번을 비교했습니다\.$/);
    expect(summary.outlook).toContain('같은 전류로 가득 채우는 시간이');
    expect(summary.nextStep).toBe('정기 용량시험 결과와 비교.');
  });

  it('el.sec_rise: 수소 1 kg당 전기 + 기준→최근 수준', () => {
    const summary = summaryOf('el.sec_rise');
    expect(summary.what).toBe('전해 스택 1(STACK1)이 수소 1 kg을 만드는 데 쓰는 전기가 처음보다 5.5% 늘었습니다.');
    expect(summary.basis).toContain('운전 부하와 스택 온도가 비슷한 구간');
    expect(summary.outlook).toBe('수소 1 kg에 58.17 kWh를 쓰던 것이 지금은 61.38 kWh입니다. 전기를 더 쓰는 만큼 수소 1 kg을 만드는 원가가 올라갑니다.');
  });

  it('tank.static_leak: 누설률은 소수 2자리, 안전 기준 초과를 말한다', () => {
    const summary = summaryOf('tank.static_leak');
    expect(summary.what).toBe('저장용기 3(TANK3)에서 수소를 넣지도 빼지도 않는 동안 수소가 하루 1.03 kg씩 줄고 있습니다.');
    expect(summary.outlook).toContain('안전 확인이 먼저인 건입니다');
    expect(summary.outlook).toContain('현장 안전책임자');
  });

  it('pv.soiling_rate: 사이트 단위 주어와 누적 손실 kWh 천 단위 구분', () => {
    const summary = summaryOf('pv.soiling_rate');
    expect(summary.what).toBe('영암 태양광·ESS 발전소의 태양광 판이 더러워지면서 발전량의 3.7%를 잃고 있습니다.');
    expect(summary.outlook).toContain('약 4,114 kWh');
    expect(summary.outlook).toContain('전기 판매 가격을 넣지 않아');
  });

  it('h2chain.mass_balance_gap: 장부가 모자라는 쪽·시작일', () => {
    const summary = summaryOf('h2chain.mass_balance_gap');
    expect(summary.what).toBe('새만금 연계형 발전소에서 만든 수소와 쓴 수소를 맞춰 보면 하루 2.3%가 모자랍니다.');
    expect(summary.outlook).toContain('계량기가 틀렸거나, 어딘가로 새고 있다는 뜻입니다');
  });

  it('dq.gap_flatline: 들어온 비율을 말하고 끊긴 지점 수를 센다', () => {
    const summary = summaryOf('dq.gap_flatline');
    expect(summary.what).toMatch(/들어와야 할 양의 \d+\.\d%만 들어왔습니다\.$/);
    expect(summary.basis).toContain('데이터가 끊긴 지점 1개');
  });

  it('el.voltage_rise·fc.voltage_decay: 1,000시간 운전당 mV로 바꿔 쓴다', () => {
    expect(summaryOf('el.voltage_rise').what).toMatch(/^전해 스택 1\(STACK1\)이 같은 양의 수소를 만드는 데 필요한 전압이 1,000시간 운전할 때마다 [\d.,]+ mV씩 오르고 있습니다\.$/);
    expect(summaryOf('fc.voltage_decay').what).toMatch(/^연료전지 스택 1\(STACK1\)이 전기를 낼 때 셀 전압이 1,000시간 운전할 때마다 [\d.,]+ mV씩 떨어지고 있습니다\.$/);
  });

  it('inv.thermal_derating: 조사가 이름 끝 숫자를 읽는 소리에 맞는다', () => {
    expect(summaryOf('inv.thermal_derating').what).toMatch(/^인버터 2\(INV02\)가 뜨거워지면/);
    expect(summaryOf('ess.resistance_growth').what).toMatch(/^배터리 랙 2\(RACK02\)가 전기를 주고받을 때/);
    expect(summaryOf('pv.inverter_peer').what).toMatch(/^인버터 4\(INV04\)가 옆의 같은 인버터들보다/);
  });
});

describe('판정 보류', () => {
  const short = (days: number): PlainCase => {
    const base = caseOf('ess.capacity_fade');
    return { ...base, finding: { ...base.finding, windowStartMs: base.finding.windowEndMs - days * MS_PER_DAY } };
  };

  it('최소 데이터 기간(용량 21일)에 못 미치면 숫자 대신 아직 이르다고 쓴다', () => {
    const { finding, evidence } = short(12);
    expect(holdReasonOf(finding, evidence)).toEqual({ span: 12, minSpan: 21, unit: 'days' });
    const summary = plainSummary(finding, evidence);
    expect(summary).toEqual({
      what: '아직 판단하기 이릅니다 — 배터리 랙 1(RACK01)의 데이터가 아직 12일치뿐입니다.',
      basis: '이 항목은 21일치는 모여야 조건이 비슷한 때끼리 견줄 수 있습니다.',
      outlook: '지금 나온 숫자는 참고만 하세요. 데이터가 더 쌓이면 판정이 바뀔 수 있습니다.',
      nextStep: '9일쯤 더 쌓인 뒤 분석을 다시 실행하세요.',
      hold: true,
    });
  });

  it('기간을 채우면 보류가 아니다', () => {
    const { finding, evidence } = short(40);
    expect(holdReasonOf(finding, evidence)).toBeNull();
    expect(plainSummary(finding, evidence).hold).toBe(false);
  });

  it('최소 기간을 정하지 않은 탐지기(데이터 품질)는 보류로 보지 않는다', () => {
    const { finding, evidence } = caseOf('dq.gap_flatline');
    expect(holdReasonOf(finding, evidence)).toBeNull();
  });
});

describe('표현 규칙', () => {
  it('심각도는 숫자 대신 할 일의 급함으로 읽는다', () => {
    expect([1, 2, 3, 4, 5].map(severityAction)).toEqual(['참고', '지켜보기', '이번 주 확인', '바로 확인', '바로 확인']);
    expect(severityAction(0)).toBe('참고');
  });

  it('주어는 설비를 부르는 이름, 설비가 없으면 사이트 이름', () => {
    expect(subjectText({ assetName: '배터리 랙 1', assetCode: 'RACK01', siteName: '영암 태양광·ESS' })).toBe('배터리 랙 1(RACK01)');
    expect(subjectText({ assetName: '배터리 랙 1', assetCode: null, siteName: '영암 태양광·ESS' })).toBe('배터리 랙 1');
    expect(subjectText({ assetName: null, assetCode: null, siteName: '영암 태양광·ESS' })).toBe('영암 태양광·ESS 발전소');
  });

  it('조사는 한글·숫자·영문 끝소리로 고른다', () => {
    expect(['배터리 랙 1(RACK01)', '인버터 2(INV02)', '수소 압축기(COMP1)', '전해 스택 1(STACK1)', '기상관측 설비'].map(hasBatchim)).toEqual([true, false, true, true, false]);
    expect(withParticle('구간', '과', '와')).toBe('구간과');
    expect(withParticle('회', '과', '와')).toBe('회와');
  });

  it('탐지기 문장을 만들 수 없으면 주어와 원래 제목으로 되돌아간다', () => {
    const headline = plainHeadline({
      detectorId: 'future.detector',
      title: '무언가 이상',
      effect: { metric: 'x', value: 1, unit: '%', ciLow: null, ciHigh: null, baseline: null, current: null, levelUnit: null },
      assetName: '인버터 4',
      assetCode: 'INV04',
      siteName: '영암 태양광·ESS',
    });
    expect(headline).toBe('인버터 4(INV04): 무언가 이상');
  });
});

describe('한계선 여유·성능 변화의 부호', () => {
  const gapyeong = (detectorId: 'hx.fouling' | 'o2.purity_drift', overrides: Partial<GapyeongEvidence>): GapyeongEvidence => ({
    kind: 'gapyeong',
    detectorId,
    subject: '산소 중 수소 농도',
    unit: 'vol%',
    referenceCount: 14,
    recentCount: 6,
    referenceLevel: 1.06,
    recentLevel: 1.54,
    limit: 2,
    limitLabel: '압축금지 한계',
    margin: null,
    extra: { alarmHolds: null, minAlarmHolds: null, leakNlPerMin: null, downstreamVolumeM3: null, uaDropPct: null, marginPctPoints: null },
    points: [],
    note: null,
    checks: [],
    ...overrides,
  });

  const outlookFor = (margin: number): string | null =>
    plainOutlook(caseOf('o2.purity_drift').finding, gapyeong('o2.purity_drift', { margin }));

  it('여유가 음수면 남았다고 하지 않고 넘었다고 말한다', () => {
    const text = outlookFor(-0.6921) ?? '';
    expect(text).toContain('압축을 멈춰야 하는 선(2%)을 이미 0.69%포인트 넘었습니다.');
    expect(text).not.toContain('남았습니다');
  });

  it('여유가 0이면 이미 닿았다고 말한다', () => {
    const text = outlookFor(0) ?? '';
    expect(text).toContain('압축을 멈춰야 하는 선(2%)에 이미 닿았습니다.');
    expect(text).not.toContain('남았습니다');
    expect(text).not.toContain('넘었습니다');
  });

  it('여유가 양수일 때만 남았다고 말한다', () => {
    const text = outlookFor(0.6921) ?? '';
    expect(text).toContain('압축을 멈춰야 하는 선(2%)까지 0.69%포인트 남았습니다.');
    expect(text).not.toContain('넘었습니다');
  });

  it('여유 문장은 부호마다 동사가 다르다', () => {
    expect([limitMarginText(-0.69, 2), limitMarginText(0, 2), limitMarginText(0.69, 2)]).toEqual([
      '압축을 멈춰야 하는 선(2%)을 이미 0.69%포인트 넘었습니다.',
      '압축을 멈춰야 하는 선(2%)에 이미 닿았습니다.',
      '압축을 멈춰야 하는 선(2%)까지 0.69%포인트 남았습니다.',
    ]);
  });

  it('열교환 성능은 저하율이 음수면 올랐다고 말한다', () => {
    expect([uaChangeText(45.2), uaChangeText(0), uaChangeText(-45.2)]).toEqual(['45.2% 떨어졌습니다', '그대로입니다', '45.2% 올랐습니다']);
    const hx = caseOf('hx.fouling');
    expect(plainOutlook(hx.finding, gapyeong('hx.fouling', { extra: { alarmHolds: null, minAlarmHolds: null, leakNlPerMin: null, downstreamVolumeM3: null, uaDropPct: -12.5, marginPctPoints: null } }))).toContain('12.5% 올랐습니다');
  });
});
