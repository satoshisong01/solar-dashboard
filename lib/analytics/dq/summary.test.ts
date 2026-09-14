import { describe, expect, it } from 'vitest';
import { dqGapFlatline } from '../detectors/dq-gap-flatline';
import { createRng } from '@/lib/sim/rng';
import { flatlineIgnoreAbsBelow, flatRunsFromSamples, hourCountsFromSamples, memoryDqInput, type DqPointMeta } from './summary';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 1, 0); // 09:00 KST
const meta = (overrides: Partial<DqPointMeta> = {}): DqPointMeta => ({ pointId: 1, assetId: 10, metricKey: 'room.temp', sourceKey: 'ESS1/T_ROOM', periodS: 300, flatlineMaxS: 6 * 3600, ...overrides });
/** 5분 주기 h시간 */
const grid = (hours: number, periodS = 300) => Array.from({ length: (hours * 3600) / periodS }, (_, i) => T0 + i * periodS * 1000);

describe('flatRunsFromSamples (SQL 고착 규칙과 같다)', () => {
  it('구간 끝 = 마지막 샘플 + 주기: 6시간 고착을 6시간으로 재 기준(이상)에 걸린다', () => {
    const ts = grid(12);
    const values = ts.map((t, i) => (t >= T0 + 3 * HOUR && t < T0 + 9 * HOUR ? 21.5 : 20 + i * 0.01));
    expect(flatRunsFromSamples(meta(), ts, values, { start: T0, end: T0 + 12 * HOUR })).toEqual([{ pointId: 1, start: T0 + 3 * HOUR, end: T0 + 9 * HOUR, value: 21.5 }]);
    const short = ts.map((t, i) => (t >= T0 + 3 * HOUR && t < T0 + 8 * HOUR ? 21.5 : 20 + i * 0.01));
    expect(flatRunsFromSamples(meta(), ts, short, { start: T0, end: T0 + 12 * HOUR })).toEqual([]);
  });

  it('결측(NaN)은 건너뛰어 구간을 끊지 않고, 창 밖 샘플은 보지 않으며, 기준이 없는 메트릭은 빈 목록', () => {
    const ts = grid(8);
    const values = ts.map((t) => (t === T0 + 2 * HOUR ? Number.NaN : 7));
    expect(flatRunsFromSamples(meta(), ts, values, { start: T0, end: T0 + 8 * HOUR })).toEqual([{ pointId: 1, start: T0, end: T0 + 8 * HOUR, value: 7 }]);
    expect(flatRunsFromSamples(meta(), ts, values, { start: T0 + 3 * HOUR, end: T0 + 8 * HOUR })).toEqual([]);
    expect(flatRunsFromSamples(meta({ flatlineMaxS: null }), ts, values, { start: T0, end: T0 + 8 * HOUR })).toEqual([]);
  });

  it('일사량은 야간 0 근처(|값| ≤ 5 W/m²) 고착을 빼고 주간 값 고착만 잡는다', () => {
    const poa = meta({ metricKey: 'poa.irradiance', sourceKey: 'WX1/POA', flatlineMaxS: 2 * 3600 });
    const ts = grid(24);
    const night = ts.map(() => 0);
    const stuckDay = ts.map((t, i) => (t < T0 + 8 * HOUR ? 312.4 : i % 7));
    expect(flatRunsFromSamples(poa, ts, night, { start: T0, end: T0 + 24 * HOUR })).toEqual([]);
    expect(flatRunsFromSamples(poa, ts, stuckDay, { start: T0, end: T0 + 24 * HOUR })).toEqual([{ pointId: 1, start: T0, end: T0 + 8 * HOUR, value: 312.4 }]);
    expect(flatlineIgnoreAbsBelow('poa.irradiance#tilt')).toBe(5);
    expect(flatlineIgnoreAbsBelow('room.temp')).toBeNull();
  });
});

describe('hourCountsFromSamples · memoryDqInput', () => {
  it('시간별 받은 샘플 수(NaN 제외) → 결측 구간·완결성, 탐지기가 6시간 결측·고착을 finding으로 올린다', () => {
    const ts = grid(24);
    const lost = ts.map((t, i) => (t >= T0 + 4 * HOUR && t < T0 + 10 * HOUR ? Number.NaN : 20 + (i % 5) * 0.1));
    expect(hourCountsFromSamples(1, ts, lost, { start: T0, end: T0 + 6 * HOUR })).toEqual([0, 1, 2, 3].map((h) => ({ pointId: 1, hourStart: T0 + h * HOUR, n: 12 })));
    const stuck = ts.map((t, i) => (t >= T0 + 12 * HOUR && t < T0 + 18 * HOUR ? 25 : 20 + (i % 5) * 0.1));
    const window = { start: T0, end: T0 + 24 * HOUR };
    const input = memoryDqInput(3, [{ meta: meta({ pointId: 1, assetId: 10 }), ts, values: lost }, { meta: meta({ pointId: 2, assetId: 11, sourceKey: 'ESS1/T_X' }), ts, values: stuck }], window);
    expect(input.points.map((p) => [p.assetId, p.receivedSamples, p.gaps, p.flatlines.length])).toEqual([
      [10, 216, [{ start: T0 + 4 * HOUR, end: T0 + 10 * HOUR }], 0],
      [11, 288, [], 1],
    ]);
    const result = dqGapFlatline.detect(input, { now: window.end, rng: createRng(1), params: {} });
    expect(result.status === 'ok' && result.findings.map((f) => [f.assetId, f.title])).toEqual([
      [10, '데이터 품질: 수신 결측'],
      [11, '데이터 품질: 센서 값 고착'],
    ]);
  });
});
