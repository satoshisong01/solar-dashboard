import { describe, expect, it } from 'vitest';
import type { DetectorOutcome } from '@/lib/analytics/pipeline/types';
import { EVAL_PRESET, evalRunPlans } from '../presets';
import type { InjectionTruth } from '../truth';
import { evalSite } from './assets';
import { selectPlans, siteJobs, type SiteJob } from './jobs';
import { detectionOf, evidenceWindows, injectionMagnitude, tallyOutcomes } from './records';
import { evaluatePreparedJob, prepareSiteJob } from './replay';
import { evaluateGates } from './scorecard';
import { scoreAll, scoreAtLeast, scoreDetector } from './score';
import type { DetectionRecord, InjectionResult, SiteJobResult } from './types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00+09:00');

describe('평가 잡 분해', () => {
  it('사이트마다 같은 시드·시나리오는 한 잡: 시드 3 × (SIM-A 5 + SIM-B 5 + SIM-C 1) = 33', () => {
    const jobs = siteJobs(evalRunPlans());
    expect(jobs).toHaveLength(33);
    const control = jobs.filter((j) => j.siteCode === 'SIM-C');
    expect(control.map((j) => j.runIds.length)).toEqual([5, 5, 5]);
    expect(control.every((j) => j.scenarios.length === EVAL_PRESET.controls.length)).toBe(true);
    expect(jobs.find((j) => j.id === 's101-SIM-A-3')?.scenarios.map((s) => s.kind)).toEqual(['fault.battery_capacity_fade', 'fault.inverter_efficiency_drop']);
  });

  it('시드·순번으로 고른다', () => {
    const plans = selectPlans(evalRunPlans(), { seeds: [202], runs: [3, 4] });
    expect(plans.map((p) => p.id)).toEqual(['eval-s202-3', 'eval-s202-4']);
    expect(siteJobs(plans).map((j) => j.id)).toEqual(['s202-SIM-A-1', 's202-SIM-B-1', 's202-SIM-C-1', 's202-SIM-A-2', 's202-SIM-B-2']);
  });

  it('가상 사이트 설비를 결정적 id와 부모 관계로 바꾼다', () => {
    const site = evalSite('SIM-B');
    const stack = site.byPath.get('SIM-B/FC1/STACK1');
    expect(stack?.parentId).toBe(site.byPath.get('SIM-B/FC1')?.id);
    expect(stack?.id).toBe(evalSite('SIM-B').byPath.get('SIM-B/FC1/STACK1')?.id);
    expect(() => evalSite('SIM-X')).toThrow('알 수 없는 가상 사이트');
  });
});

const injection = (overrides: Partial<InjectionTruth> = {}): InjectionTruth => ({
  siteCode: 'SIM-A',
  assetPath: 'SIM-A/ESS1/RACK01',
  kind: 'fault.battery_capacity_fade',
  startTs: T0 + 30 * DAY,
  endTs: T0 + 100 * DAY,
  params: { totalPct: 5, days: 30 },
  expectedFailureModes: ['ess.capacity_fade'],
  expectedDetectors: ['ess.capacity_fade'],
  ...overrides,
});

const detection = (day: number, assetId: number, effect = -5): DetectionRecord => ({ ts: T0 + day * DAY, detectorId: 'ess.capacity_fade', assetId, failureMode: 'ess.capacity_fade', severity: 3, confidence: 0.8, effect, ciLow: null, ciHigh: null, windows: null });

function job(overrides: Partial<SiteJobResult> = {}): SiteJobResult {
  const checkpointTs = Array.from({ length: 15 }, (_, i) => T0 + (28 + 7 * i) * DAY);
  const hit: InjectionResult = { injection: injection(), detectorId: 'ess.capacity_fade', assetId: 1, magnitude: 5, unit: '%', firstDetectionTs: T0 + 48 * DAY, finalEffect: -5.4, trueEffect: -5 };
  return {
    jobId: 'j1',
    seed: 1,
    siteCode: 'SIM-A',
    runIds: ['r1'],
    fromMs: T0,
    toMs: T0 + 126 * DAY,
    checkpointTs,
    applicableAssets: { 'ess.capacity_fade': 4 },
    // 설비 1: 주입 전 오탐 1건(21일째 점검) + 주입 후 탐지 / 설비 2: 연속 두 점검 오탐 1건 + 떨어진 오탐 1건
    detections: [detection(28, 1), detection(56, 1), detection(63, 1), detection(35, 2), detection(42, 2), detection(84, 2)],
    injections: [hit, { ...hit, injection: injection({ params: { totalPct: 3, days: 30 } }), magnitude: 3, firstDetectionTs: null, finalEffect: null, trueEffect: null }],
    controls: [],
    tallies: [],
    stats: { simulationMs: 0, extractionMs: 0, detectionMs: 0, samples: 0, episodes: 0 },
    ...overrides,
  };
}

describe('스코어', () => {
  it('TP·FP(연속 점검은 한 건)·FN·자산월·지연·크기 오차·크기별 곡선', () => {
    const score = scoreDetector([job()], 'ess.capacity_fade');
    expect(score).toMatchObject({ tp: 1, fp: 3, fn: 1, recall: 0.5, precision: 0.25, medianDelayDays: 18, minDetectableMagnitude: 5 });
    expect(score.magnitudeMae).toBeCloseTo(0.4, 9);
    expect(score.assetMonths).toBeCloseTo((4 * 98) / 30.44, 6);
    expect(score.falsePositives.map((f) => [f.assetId, (f.firstTs - T0) / DAY, f.checkpoints])).toEqual([
      [1, 28, 1],
      [2, 35, 2],
      [2, 84, 1],
    ]);
    expect(score.curve.map((p) => [p.magnitude, p.detected, p.injections])).toEqual([
      [3, 0, 1],
      [5, 1, 1],
    ]);
    expect(scoreAtLeast([job()], 'ess.capacity_fade', 5)).toMatchObject({ injections: 1, recall: 1, medianDelayDays: 18 });
  });

  it('게이트: 평가할 주입이 없으면 실패로 본다', () => {
    const gates = evaluateGates([job()], scoreAll([job()]));
    expect(gates.find((g) => g.id === 'ess.capacity_fade.recall_5pct')?.pass).toBe(true);
    expect(gates.find((g) => g.id === 'ess.capacity_fade.fp_per_asset_month')?.pass).toBe(false);
    expect(gates.find((g) => g.id === 'el.voltage_rise.recall_20uvh')).toMatchObject({ value: null, pass: false });
  });
});

describe('평가 기록', () => {
  it('근거 창·주입 크기·상태 집계', () => {
    expect(evidenceWindows({ reference: { from: 1, to: 2 }, recent: { from: 3, to: 4 } })).toEqual({ referenceFrom: 1, referenceTo: 2, recentFrom: 3, recentTo: 4 });
    expect(evidenceWindows({ reference: { from: 1 } })).toBeNull();
    expect(injectionMagnitude(injection({ kind: 'fault.elz_stack_degradation', params: { uvPerH: 20 } }))).toEqual({ magnitude: 20, unit: 'µV/h' });
    expect(injectionMagnitude(injection({ kind: 'fault.inverter_efficiency_drop', params: { pctPoints: 2 } }))).toEqual({ magnitude: 2, unit: '%p' });
    const base: DetectorOutcome = { detectorId: 'el.voltage_rise', detectorVersion: '1', siteId: 1, assetId: 5, status: 'insufficient', findings: [], reason: '누적 운전시간 범위 부족: 12 h (100 h 필요)', configVersions: [] };
    const tally = tallyOutcomes([base, { ...base, reason: '누적 운전시간 범위 부족: 40 h (100 h 필요)' }, { ...base, status: 'ok', reason: null }]).find((t) => t.detectorId === 'el.voltage_rise');
    expect(tally).toMatchObject({ ok: 1, insufficient: 2, error: 0, topReasons: [['누적 운전시간 범위 부족: # h (# h 필요)', 2]] });
    expect(detectionOf([base], T0)).toEqual([]);
  });
});

describe('메모리 모드 사이트 잡 (짧은 실행)', () => {
  it('SIM-A 45일: 22일째 랙 용량 10% 감소를 에피소드 추출 → 탐지기로 찾고 참 SOH와 크기를 비교한다', () => {
    const siteJob: SiteJob = {
      id: 't-SIM-A',
      seed: 7,
      siteCode: 'SIM-A',
      from: '2026-01-01T00:00:00+09:00',
      days: 45,
      scenarios: [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay: 22, totalPct: 10, days: 2 }],
      runIds: ['t'],
    };
    const prepared = prepareSiteJob(siteJob);
    expect(prepared.episodes.some((e) => e.kind === 'pv.day')).toBe(true);
    expect(Object.keys(prepared.soh)).toContain('SIM-A/ESS1/RACK01');
    const result = evaluatePreparedJob(prepared, { firstCheckpointDay: 28, checkpointStepDays: 7, detectorIds: ['ess.capacity_fade'] });
    expect(result.checkpointTs.map((ts) => (ts - T0) / DAY)).toEqual([28, 35, 42, 45]);
    expect(result.applicableAssets['ess.capacity_fade']).toBe(4);
    expect(result.injections).toHaveLength(1);
    const [hit] = result.injections;
    expect(hit?.firstDetectionTs).not.toBeNull();
    expect(Math.abs((hit?.finalEffect ?? 0) - (hit?.trueEffect ?? 99))).toBeLessThan(1);
    expect(scoreDetector([result], 'ess.capacity_fade').fp).toBe(0);
  }, 60_000);
});
