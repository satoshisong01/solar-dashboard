import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { applyScale } from '@/lib/ingest/normalize';
import { QUALITY } from '@/lib/ingest/quality';
import type { IngestSeries } from './envelope';
import { simulate } from './index';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { DETECTOR_METRICS, detectorPointFilter, P3_DETECTOR_METRICS, pointKey, simulateMemory, type MemorySimulationResult } from './memory';
import type { Scenario } from './scenarios';

const FROM = Date.parse('2026-06-01T00:00:00+09:00');
const timestamps = (series: IngestSeries): number[] => ('ts' in series ? [...series.ts] : series.v.map((_, i) => series.t0 + i * series.dt));
const ALL = ['SIM-A', 'SIM-B', 'SIM-C'];
/** 이 테스트가 도는 사이트만 (SIM-D 가평 복제는 규모가 커서 따로 본다) */
const TEST_SITES = SIM_SITES.filter((s) => ALL.includes(s.code));
const SCENARIOS: readonly Scenario[] = [
  { kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV02', pctPoints: 3 },
  { kind: 'control.curtailment', site: 'SIM-C', startDay: 0, count: 1 },
  { kind: 'dq.spike', site: 'SIM-B', sourceKey: 'H2BANK1/TANK1/P', perDay: 20, magnitude: 40 },
];

describe('simulateMemory — 하루 3사이트', () => {
  let result: MemorySimulationResult;

  beforeAll(() => {
    result = simulateMemory({ siteCodes: ALL, from: FROM, to: FROM + MS_PER_DAY, seed: 42, scenarios: SCENARIOS });
  }, 60_000);

  it('매핑된 포인트마다 period_s 간격 시계열을 만들고 시각 배열은 주기별로 공유한다', () => {
    const mappedPoints = TEST_SITES.flatMap((s) => s.assets.flatMap((a) => a.points));
    const soc = result.series.get('SIM-A/ESS1/RACK01|batt.soc');
    const tankP = result.series.get(pointKey('SIM-B/H2BANK1/TANK1', 'tank.pressure'));

    expect(result.series.size).toBe(mappedPoints.length);
    expect(soc?.ts).toHaveLength(1_440);
    expect(soc?.ts[0]).toBe(FROM);
    expect(soc?.ts[1_439]).toBe(FROM + MS_PER_DAY - 60_000);
    expect(tankP?.ts).toHaveLength(288);
    expect(result.series.get('SIM-C/ESS1/RACK02|batt.soc')?.ts).toBe(soc?.ts);
    expect(result.stats.samples).toBe(mappedPoints.reduce((sum, p) => sum + 86_400 / p.periodS, 0));
    expect(result.stats.steps).toBe(3 * 1_440);
    expect(result.series.get('SIM-B/ELZ1/WTU1|water.conductivity#loop')).toBeDefined();
  });

  it('값은 simulate()가 보내는 원본값에 scale·offset을 적용한 값(= DB 저장값)과 같다', async () => {
    const points = new Map(TEST_SITES.flatMap((s) => s.assets.flatMap((a) => a.points.map((p) => [`${s.code}:${p.sourceKey}`, { path: `${s.code}/${a.code}`, point: p }] as const))));
    let compared = 0;
    for await (const batch of simulate({ siteCodes: ALL, from: FROM, to: FROM + MS_PER_DAY, seed: 42, scenarios: SCENARIOS })) {
      for (const series of batch.envelope.series) {
        const mapped = points.get(`${batch.siteCode}:${series.src}`);
        if (!mapped) continue;
        const memory = result.series.get(pointKey(mapped.path, mapped.point.metricKey, mapped.point.qualifier));
        const ts = timestamps(series);
        series.v.forEach((raw, i) => {
          const index = Math.round(((ts[i] ?? 0) - FROM) / (mapped.point.periodS * 1_000));
          expect(memory?.value[index], `${batch.siteCode} ${series.src}`).toBe(applyScale(raw ?? Number.NaN, mapped.point));
          compared += 1;
        });
      }
    }
    expect(compared).toBe(result.stats.samples);
  }, 60_000);

  it('고장·대조군이 값에 반영되고, 이벤트와 정답 기록을 함께 돌려준다', () => {
    const limit = result.series.get('SIM-C/PV1/INV01|ac.power.limit');
    const at = (hour: number) => Math.round((hour * MS_PER_HOUR) / 300_000);

    expect([limit?.value[at(10)], limit?.value[at(12)], limit?.value[at(15)]]).toEqual([100, 0, 100]);
    expect(result.truth.injections.map((i) => i.kind)).toEqual(['fault.inverter_efficiency_drop', 'dq.spike']);
    expect(result.truth.controls.map((c) => c.kind)).toEqual(['control.curtailment']);
    expect(result.events.some((e) => e.siteCode === 'SIM-B' && e.src === 'ELZ1/EVENT')).toBe(true);
  });

  it('범위를 벗어난 스파이크는 HARD_RANGE 품질 비트를 받는다', () => {
    const tank = result.series.get('SIM-B/H2BANK1/TANK1|tank.pressure');
    const flagged = Array.from(tank?.quality ?? []).filter((q) => q === QUALITY.HARD_RANGE).length;

    expect(flagged).toBeGreaterThan(0);
    expect(Array.from(result.series.get('SIM-B/H2BANK1/TANK2|tank.pressure')?.quality ?? []).every((q) => q === 0)).toBe(true);
  });
});

describe('simulateMemory — 옵션', () => {
  it('같은 옵션이면 같은 값, 필터는 포인트만 줄이고 값은 바꾸지 않는다', () => {
    const options = { siteCodes: ['SIM-B'], from: FROM, to: FROM + 6 * MS_PER_HOUR, seed: 7 };
    const full = simulateMemory(options);
    const again = simulateMemory(options);
    const filtered = simulateMemory({ ...options, pointFilter: detectorPointFilter });
    const key = 'SIM-B/ELZ1/STACK1|stack.voltage';

    expect(Array.from(again.series.get(key)?.value ?? [])).toEqual(Array.from(full.series.get(key)?.value ?? []));
    expect(filtered.series.size).toBeLessThan(full.series.size);
    expect([...filtered.series.values()].every((s) => DETECTOR_METRICS[s.classKey]?.includes(s.metricKey))).toBe(true);
    expect(Array.from(filtered.series.get(key)?.value ?? [])).toEqual(Array.from(full.series.get(key)?.value ?? []));
    expect(filtered.stats.bytes).toBeLessThan(full.stats.bytes);
  });

  it('결측 주입(dq.sample_loss): 메모리 값은 NaN(저장되지 않은 샘플), simulate()는 그 샘플을 보내지 않는다', async () => {
    const scenarios: Scenario[] = [{ kind: 'dq.sample_loss', site: 'SIM-A', sourceKey: 'WX1/T_AMB', start: FROM + MS_PER_HOUR, durationS: 3_600 }];
    const memory = simulateMemory({ siteCodes: ['SIM-A'], from: FROM, to: FROM + 3 * MS_PER_HOUR, seed: 5, scenarios });
    const ambient = Array.from(memory.series.get('SIM-A/WX1|ambient.temp')?.value ?? []);
    expect(ambient).toHaveLength(36);
    expect(ambient.map((v, i) => [i, Number.isNaN(v)]).filter(([, lost]) => lost).map(([i]) => i)).toEqual(Array.from({ length: 12 }, (_, k) => 12 + k));
    expect(memory.truth.injections).toEqual([expect.objectContaining({ kind: 'dq.sample_loss', assetPath: 'SIM-A/WX1', params: { sourceKey: 'WX1/T_AMB', durationHours: 1 }, expectedDetectors: ['dq.gap_flatline'] })]);
    let sent = 0;
    for await (const batch of simulate({ siteCodes: ['SIM-A'], from: FROM, to: FROM + 3 * MS_PER_HOUR, seed: 5, scenarios })) {
      sent += batch.envelope.series.filter((s) => s.src === 'WX1/T_AMB').reduce((sum, s) => sum + s.v.length, 0);
    }
    expect(sent).toBe(24);
  }, 60_000);

  it('탐지기 메트릭 목록(P2·P3)은 모두 실제 포인트를 가리킨다', () => {
    for (const [classKey, metrics] of [...Object.entries(DETECTOR_METRICS), ...Object.entries(P3_DETECTOR_METRICS)]) {
      for (const metric of metrics) {
        const exists = SIM_SITES.some((s) => s.assets.some((a) => a.classKey === classKey && a.points.some((p) => p.metricKey === metric)));
        expect(exists, `${classKey} ${metric}`).toBe(true);
      }
    }
  });

  it('예상 메모리가 한도를 넘으면 시작 전에 거부하고, 실행시간은 주입한 시계로 잰다', () => {
    const ticks = [1_000, 3_500];
    const result = simulateMemory({ siteCodes: ['SIM-A'], from: FROM, to: FROM + MS_PER_HOUR, seed: 1, now: () => ticks.shift() ?? 0 });

    expect(result.stats.elapsedMs).toBe(2_500);
    expect(() => simulateMemory({ siteCodes: ['SIM-A'], from: FROM, to: FROM + 365 * MS_PER_DAY, seed: 1, maxBytes: 100 * 1024 ** 2 })).toThrow('pointFilter');
    expect(() => simulateMemory({ siteCodes: ['SIM-A', 'SIM-A'], from: FROM, to: FROM + MS_PER_HOUR, seed: 1 })).toThrow('중복');
    expect(() => simulateMemory({ siteCodes: ['SIM-A'], from: FROM, to: FROM + MS_PER_HOUR, seed: -1 })).toThrow('seed');
  });

  it('실행시간: 3사이트 × 3일 × 탐지기 포인트가 수 초 안에 끝난다 (1년 환산 수 분 이내)', () => {
    const result = simulateMemory({ siteCodes: ALL, from: FROM, to: FROM + 3 * MS_PER_DAY, seed: 3, pointFilter: detectorPointFilter });
    const projectedYearS = (result.stats.elapsedMs / 3) * 365 / 1_000;
    console.info(`[sim] 메모리 모드 3일 × 3사이트: ${result.stats.elapsedMs.toFixed(0)} ms, ${result.stats.samples} 샘플, ${(result.stats.bytes / 1024 ** 2).toFixed(1)} MB → 1년 환산 ${projectedYearS.toFixed(0)} s`);

    expect(result.stats.elapsedMs).toBeLessThan(20_000);
    expect(projectedYearS).toBeLessThan(600);
  }, 60_000);
});
