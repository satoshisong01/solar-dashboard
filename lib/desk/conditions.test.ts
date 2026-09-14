import { describe, expect, it } from 'vitest';
import {
  capacityBinLabel,
  capacityConditionSentence,
  chargeTimeText,
  convertedChargeTime,
  formatHoursMinutes,
  parseCapacityBinKey,
  sessionRuleText,
  type CapacityBinView,
} from './conditions';

const WIDTHS = { cRate: 0.05, tempC: 5 };
const RULES = { anchorSocMaxPct: 20, minCcSocSpanPct: 40, minSocSpanPct: 40 };
const bin = (key: string, nRef: number, nCur: number, used = true): CapacityBinView => ({ key, nRef, nCur, medRef: 400, medCur: 375, ratio: 0.9375, used });

describe('capacity bin 키', () => {
  it('키를 C-rate·온도 하한으로 읽고, 온도 없음(na)은 null', () => {
    expect(parseCapacityBinKey('0.15|20')).toEqual({ cRate: 0.15, tempC: 20 });
    expect(parseCapacityBinKey('0.1|na')).toEqual({ cRate: 0.1, tempC: null });
    expect(parseCapacityBinKey('bad')).toEqual({ cRate: null, tempC: null });
  });

  it('bin 라벨은 폭을 더한 구간 (부동소수 잡음 없이)', () => {
    expect(capacityBinLabel('0.1|20', WIDTHS)).toBe('0.10~0.15C · 20~25°C');
    expect(capacityBinLabel('0.15|na', WIDTHS)).toBe('0.15~0.20C · 셀온도 없음');
    expect(capacityBinLabel('0.2|-5', { cRate: 0.1, tempC: 2.5 })).toBe('0.20~0.30C · -5.0~-2.5°C');
  });
});

describe('capacityConditionSentence', () => {
  it('설계 §3.1 예시 문장: 앵커 세션 한 bin', () => {
    expect(capacityConditionSentence({ metric: 'capacity_ah_anchored', bins: [bin('0.2|20', 18, 9)], widths: WIDTHS, rules: RULES })).toBe(
      '충전전류 0.20~0.25C, 셀온도 20~25°C, 휴지 후 SOC ≤ 20% 시작 → 완충, 기준 18회·최근 9회',
    );
  });

  it('비교에 쓴 bin만 범위·표본 수에 넣는다', () => {
    const bins = [bin('0.05|20', 0, 2, false), bin('0.1|20', 13, 11), bin('0.15|25', 7, 7), bin('0.2|20', 0, 1, false)];
    expect(capacityConditionSentence({ metric: 'capacity_ah_soc', bins, widths: WIDTHS, rules: RULES })).toBe(
      '충전전류 0.10~0.20C, 셀온도 20~30°C, SOC 변화 ≥ 40%·휴지로 끝난 부분 충전, 기준 20회·최근 18회',
    );
  });

  it('온도 bin이 모두 없으면 온도 구간을 빼고, 쓴 bin이 없으면 null', () => {
    expect(capacityConditionSentence({ metric: 'capacity_ah_cc', bins: [bin('0.1|na', 15, 15)], widths: WIDTHS, rules: RULES })).toBe(
      '충전전류 0.10~0.15C, 휴지 후 시작, 상한 전 CC 구간 SOC 변화 ≥ 40%, 기준 15회·최근 15회',
    );
    expect(capacityConditionSentence({ metric: 'capacity_ah_anchored', bins: [bin('0.1|20', 3, 1, false)], widths: WIDTHS, rules: RULES })).toBeNull();
  });

  it('세션 규칙 문구는 지표마다 다르다', () => {
    expect(sessionRuleText('capacity_ah_anchored', { ...RULES, anchorSocMaxPct: 15 })).toBe('휴지 후 SOC ≤ 15% 시작 → 완충');
  });
});

describe('기준 전류 환산 충전시간', () => {
  it('설계 §3.1 예시: 400 Ah → 375 Ah, 50 A 기준 8h 00m → 7h 30m', () => {
    const comparison = convertedChargeTime(400, 375, 50);
    expect(comparison).toEqual({ referenceCurrentA: 50, baselineHours: 8, currentHours: 7.5, deltaMinutes: -30 });
    expect(chargeTimeText(comparison as NonNullable<typeof comparison>)).toBe('50 A 기준 8h 00m → 7h 30m');
  });

  it('분은 반올림하고 두 자리로 쓴다', () => {
    expect(formatHoursMinutes(7.2584)).toBe('7h 16m'); // 435.504분 → 436분
    expect(formatHoursMinutes(0.999)).toBe('1h 00m');
    expect(formatHoursMinutes(-1)).toBe('—');
    const odd = convertedChargeTime(586.52, 543.14, 58.66);
    expect(odd && chargeTimeText(odd)).toBe('58.7 A 기준 10h 00m → 9h 16m');
  });

  it('전류가 0 이하이거나 값이 없으면 계산하지 않는다', () => {
    expect(convertedChargeTime(400, 375, 0)).toBeNull();
    expect(convertedChargeTime(null, 375, 50)).toBeNull();
    expect(convertedChargeTime(400, Number.NaN, 50)).toBeNull();
  });
});
