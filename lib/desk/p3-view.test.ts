import { describe, expect, it } from 'vitest';
import { parseP3Evidence } from './p3-evidence';
import { EL_SEC_RISE_SNAPSHOT, MASS_BALANCE_SNAPSHOT_V1, SOILING_SNAPSHOT_V1, TANK_LEAK_SNAPSHOT, THERMAL_SNAPSHOT } from './p3-evidence-fixtures';
import { ambientBinOf, ambientBinWidth, chainSectionHref, cleaningEconomics, kstNoonMs, p3ConditionText, resetKindLabel, thermalBinSeries } from './p3-view';

const view = (snapshot: unknown) => {
  const parsed = parseP3Evidence(snapshot);
  if (parsed === null) throw new Error('P3 근거가 아닙니다');
  return parsed;
};

describe('P3 근거 화면 계산', () => {
  it('KST 날짜 → 정오 ms, 형식이 틀리면 null', () => {
    expect(kstNoonMs('2026-09-15')).toBe(Date.UTC(2026, 8, 15, 3));
    expect(kstNoonMs('2026-9-15')).toBeNull();
  });

  it('외기 bin: 키 간격으로 폭을 정하고 일 최고 외기를 내림으로 배정한다 (외기 없음은 끝)', () => {
    expect(ambientBinWidth([{ binC: 20, nRef: 1, nCur: 1, refDerateH: 0, curDerateH: 0 }, { binC: 30, nRef: 1, nCur: 1, refDerateH: 0, curDerateH: 0 }])).toBe(10);
    expect(ambientBinWidth([])).toBe(5);
    expect(ambientBinOf(29.99, 5)).toBe(25);
    const series = thermalBinSeries({
      ambientBins: [{ binC: 25, nRef: 1, nCur: 1, refDerateH: 0, curDerateH: 0 }, { binC: 30, nRef: 1, nCur: 1, refDerateH: 0, curDerateH: 0 }],
      days: [
        { date: '2026-08-16', derateH: 1.5, lossKwh: 26, ambientMaxC: 30.8 },
        { date: '2026-08-17', derateH: 1, lossKwh: 16, ambientMaxC: 29.4 },
        { date: '2026-08-18', derateH: 0.5, lossKwh: 5, ambientMaxC: null },
        { date: '2026-08-19', derateH: null, lossKwh: null, ambientMaxC: 31 },
      ],
    });
    expect(series.map((s) => [s.label, s.points.length])).toEqual([
      ['외기 25~30 °C', 1],
      ['외기 30~35 °C', 1],
      ['외기 없음', 1],
    ]);
  });

  it('체인 원장 링크: 근거 일 행 첫날~마지막 날 사용자 지정 기간', () => {
    expect(chainSectionHref('SIM-B', [{ date: '2026-09-14' }, { date: '2026-05-18' }])).toBe('/sites/SIM-B?chain=custom&from=2026-05-18&to=2026-09-14#chain');
    expect(chainSectionHref('SIM-B', [])).toBe('/sites/SIM-B#chain');
  });

  it('세척 경제성: 가격 없음 · 세척비 미만 · 초과', () => {
    const base = { economics: { cumulativeLossKwh: 4000, dailyLossKwh: 120, lossValueKrw: null }, cleaningCostKrw: 3_000_000 };
    expect(cleaningEconomics({ ...base, smpKrwPerKwh: null })).toEqual({ lossValueKrw: null, shareOfCleaningPct: null, verdict: 'no_price' });
    expect(cleaningEconomics({ ...base, smpKrwPerKwh: 150 })).toEqual({ lossValueKrw: 600_000, shareOfCleaningPct: 20, verdict: 'wait' });
    expect(cleaningEconomics({ ...base, economics: { ...base.economics, lossValueKrw: 3_300_000 }, smpKrwPerKwh: 150 }).verdict).toBe('clean');
    expect(resetKindLabel('cleaning')).toBe('세척');
  });

  it('효과 카드 조건 문장 (탐지기별)', () => {
    expect(p3ConditionText(view(EL_SEC_RISE_SNAPSHOT))).toMatch(/^같은 조건 bin \d+개\(.+\), 기준 \d+구간·최근 \d+구간, 운전 조건 기준: AC 전력 bin 50 kW$/);
    expect(p3ConditionText(view(TANK_LEAK_SNAPSHOT))).toContain('NIST 상태식, 내용적 1.85 m³');
    expect(p3ConditionText(view(MASS_BALANCE_SNAPSHOT_V1))).toBe('최근 유효 6일 잔차율 중앙값 +2.28%, 기준 14일 중앙값 +0.02%, CUSUM(k 0.5·h 4) 경보 2026-08-16');
    expect(p3ConditionText(view(SOILING_SNAPSHOT_V1))).toBe('맑은 날 온도 보정 성능지수 11일(2026-07-06 ~ 2026-09-15), 마지막 복원 2026-07-06 강우·복원(성능지수 급상승) 이후 구간 Theil–Sen 기울기');
    expect(p3ConditionText(view(THERMAL_SNAPSHOT))).toContain('방열판 65 °C 이상에서 동종 중앙값보다 5% 이상 낮은 시간');
  });
});
