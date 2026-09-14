import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR } from '../types';
import { restPairSamples, sessionSamples, type RestPairRules } from './ess-capacity-samples';
import { restCycleHistory } from './rest-fixtures';
import { chargeSession } from './test-fixtures';

const RULES: RestPairRules = { restMinutes: 30, minDeltaSocRest: 25, socSigmaPct: 1, currentGainSigma: 0.005, restPairMaxHours: 36, restPairMinCoverage: 0.98, tempBinWidthC: 5, minCompleteness: 0.95, restThresholdC: 0.02 };

describe('restPairSamples (휴지 앵커)', () => {
  it('휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC = 유효용량, 방향(chg·dis)×온도 bin, 충방전이 섞여도 순 Ah로 계산', () => {
    const history = restCycleHistory({ days: 4, seed: 1, capacityAh: () => 400, socNoisePct: 0 });
    const samples = restPairSamples({ ratedCapacityAh: 400, ...history }, RULES);
    // 하루 2쌍: 밤 → 오후(충전, +ΔSOC), 오후 → 밤(방전, −ΔSOC)
    expect(samples).toHaveLength(8);
    samples.forEach((s) => expect(s.value).toBeCloseTo(400, 6));
    expect(samples.map((s) => s.bin)).toEqual(['chg|20', 'dis|20', 'chg|20', 'dis|20', 'chg|20', 'dis|20', 'chg|20', 'dis|20']);
    // 가중치 = 1 / 상대분산: ΔSOC 30 → (√2/30)² + (0.005·120/120)², ΔSOC 70 → (√2/70)² + (0.005·280/280)²
    expect(samples[0]?.weight).toBeCloseTo(1 / ((Math.SQRT2 / 30) ** 2 + 0.005 ** 2), 6);
    expect(samples[2]?.weight).toBeCloseTo(1 / ((Math.SQRT2 / 70) ** 2 + 0.005 ** 2), 6);
    expect(samples[2]?.weight ?? 0).toBeGreaterThan((samples[0]?.weight ?? 0) * 4);
  });

  it('중간에 짧은 휴지·여러 충방전이 섞여도 연속한 앵커 사이 순 Ah를 모두 더한다', () => {
    const history = restCycleHistory({ days: 2, seed: 2, capacityAh: () => 400, socNoisePct: 0 });
    // 오후 휴지를 10분으로 줄이면 앵커가 아니므로 밤 → 밤 쌍(충전 + 짧은 휴지 + 방전, ΔSOC ≈ 0)은 ΔSOC 부족으로 빠진다
    const short = history.rests.map((r, i) => (i % 2 === 1 ? { ...r, features: { ...r.features, duration_s: 600 } } : r));
    expect(restPairSamples({ ratedCapacityAh: 400, ...history, rests: short }, RULES)).toEqual([]);
  });

  it('ΔSOC 부족·부호 불일치·빈틈(덮는 비율 미달)·무효 에피소드·비현실적 용량은 뺀다', () => {
    const history = restCycleHistory({ days: 1, seed: 3, capacityAh: () => 400, spanPct: () => 20, socNoisePct: 0 });
    expect(restPairSamples({ ratedCapacityAh: 400, ...history }, RULES)).toEqual([]);
    const ok = restCycleHistory({ days: 1, seed: 3, capacityAh: () => 400, spanPct: () => 60, socNoisePct: 0 });
    const withGap = { ...ok, charges: ok.charges.map((c) => ({ ...c, end: c.end - MS_PER_HOUR })) };
    expect(restPairSamples({ ratedCapacityAh: 400, ...withGap }, RULES).map((s) => s.bin)).toEqual(['dis|20']);
    const invalid = { ...ok, discharges: ok.discharges.map((d) => ({ ...d, valid: false })) };
    expect(restPairSamples({ ratedCapacityAh: 400, ...invalid }, RULES).map((s) => s.bin)).toEqual(['chg|20']);
    const flipped = { ...ok, discharges: ok.discharges.map((d) => ({ ...d, features: { ...d.features, ah_out: -d.features.ah_out } })) };
    expect(restPairSamples({ ratedCapacityAh: 400, ...flipped }, RULES).map((s) => s.bin)).toEqual(['chg|20']);
    expect(restPairSamples({ ratedCapacityAh: 150, ...ok }, RULES)).toEqual([]);
    expect(restPairSamples({ ratedCapacityAh: 0, ...ok }, RULES)).toEqual([]);
  });
});

describe('sessionSamples', () => {
  it('충전 세션의 방식 값·C-rate×온도 bin, 값 없는 세션과 완결성 미달은 뺀다', () => {
    const sessions = [chargeSession({ day: 0, capacityAh: 400, cRateBin: 0.1, tBin: 20 }), chargeSession({ day: 1, capacityAh: 390, anchored: false })];
    expect(sessionSamples(sessions, 'capacity_ah_anchored', { cRateBinWidth: 0.05, tempBinWidthC: 5, minCompleteness: 0.95 })).toEqual([{ start: sessions[0]?.start, end: sessions[0]?.end, value: 400, weight: 1, bin: '0.1|20', completeness: 1 }]);
    const low = sessions.map((s) => ({ ...s, dq: { ...s.dq, completeness: 0.5 } }));
    expect(sessionSamples(low, 'capacity_ah_soc', { cRateBinWidth: 0.05, tempBinWidthC: 5, minCompleteness: 0.95 })).toEqual([]);
  });
});
