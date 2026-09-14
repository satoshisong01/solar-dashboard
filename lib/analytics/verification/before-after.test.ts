import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { chargeSession, DAY0, elRuns } from '../detectors/test-fixtures';
import type { StoredEpisode } from '../pipeline/types';
import { MS_PER_DAY } from '../types';
import { beforeAfter, VERIFICATION_METRICS } from './before-after';

const before = { start: DAY0, end: DAY0 + 10 * MS_PER_DAY };
const after = { start: DAY0 + 12 * MS_PER_DAY, end: DAY0 + 22 * MS_PER_DAY };

function dvSessions(beforeMv: number, afterMv: number): StoredEpisode[] {
  const rng = createRng(4);
  return Array.from({ length: 22 }, (_, day) => chargeSession({ day, capacityAh: 400, dvMv: (day < 11 ? beforeMv : afterMv) + 0.3 * rng.gaussian() }));
}

describe('matched_before_after@1', () => {
  it('셀 전압 편차가 줄면(감소 기대) improved, CI는 0 아래', () => {
    const result = beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(30, 12), rng: createRng(1) });
    expect(result.verdict).toBe('improved');
    expect(result.effect).toBeCloseTo(-18, 0);
    expect(result.ciHigh).toBeLessThan(0);
    expect(result.beforeStats).toMatchObject({ metric: 'ess.cell_dv_mv', unit: 'mV', n: 10 });
    expect(result.afterStats).toMatchObject({ n: 10 });
  });

  it('반대로 커지면 worse, 작은 변화는 no_change, 표본이 모자라거나 모르는 지표면 insufficient_data', () => {
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 30), rng: createRng(2) }).verdict).toBe('worse');
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 11), rng: createRng(3) }).verdict).toBe('no_change');
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 11).slice(0, 13), rng: createRng(3) })).toMatchObject({ verdict: 'insufficient_data', effect: null });
    expect(beforeAfter({ assetId: 7, metric: 'x.unknown', direction: 'increase', minDelta: 1, before, after, episodes: [], rng: createRng(3) }).beforeStats).toEqual({ error: '지원하지 않는 검증 지표: x.unknown' });
  });

  it('용량(C-rate×온도 bin)·전해조 셀 전압 지표 값을 에피소드에서 읽는다', () => {
    const session = chargeSession({ day: 1, capacityAh: 400, anchored: false, ccCapacity: false });
    expect(VERIFICATION_METRICS['ess.capacity_ah']?.value(session)).toBeCloseTo(398, 0);
    expect(VERIFICATION_METRICS['ess.capacity_ah']?.bin(session)).toBe('0.1|25');
    const run = { ...elRuns({ count: 2, startHours: 1200, endHours: 1300, rateUvPerH: 0, seed: 1 })[0], assetId: 7 } as StoredEpisode;
    expect(VERIFICATION_METRICS['el.v_cell_v']?.value(run)).toBeGreaterThan(1.5);
    expect(VERIFICATION_METRICS['fc.v_cell_v']?.value(run)).toBeNull();
  });
});
