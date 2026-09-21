import { describe, expect, it } from 'vitest';
import type { DetectorOutcome } from '@/lib/analytics/pipeline/types';
import { EVAL_PRESET, evalRunPlans } from '../presets';
import type { InjectionTruth } from '../truth';
import { evalSite } from './assets';
import { selectPlans, siteJobs, type SiteJob } from './jobs';
import { detectionOf, evidenceWindows, injectionMagnitude, tallyOutcomes } from './records';
import { evaluatePreparedJob, prepareSiteJob, relatedWindowsOf } from './replay';
import { capacityAvailability, socLimitControlScore } from './availability';
import { evaluateGates } from './scorecard';
import { scoreAll, scoreAtLeast, scoreDetector } from './score';
import type { CheckpointStatus, DetectionRecord, InjectionResult, SiteJobResult } from './types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00+09:00');

describe('평가 잡 분해', () => {
  it('사이트마다 같은 시드·시나리오는 한 잡: 시드 3 × P2(SIM-A 5 + SIM-B 5 + SIM-C 1) + 시드 3 × P3(SIM-A 4 + SIM-B 13 + SIM-C 1) + 시드 3 × 가평(SIM-D 7) = 108', () => {
    const jobs = siteJobs(evalRunPlans());
    expect(jobs).toHaveLength(108);
    expect(jobs.filter((j) => j.siteCode === 'SIM-D')).toHaveLength(21);
    const p2Jobs = jobs.filter((j) => j.runIds.every((id) => !id.includes('-p3-') && !id.includes('-gp-')));
    expect(p2Jobs).toHaveLength(33);
    const control = p2Jobs.filter((j) => j.siteCode === 'SIM-C');
    expect(control.map((j) => j.runIds.length)).toEqual([5, 5, 5]);
    expect(control.every((j) => j.scenarios.length === EVAL_PRESET.controls.length)).toBe(true);
    const p3Control = jobs.filter((j) => j.siteCode === 'SIM-C' && j.runIds.some((id) => id.includes('-p3-')));
    expect(p3Control.map((j) => j.runIds.length)).toEqual([EVAL_PRESET.p3.runs, EVAL_PRESET.p3.runs, EVAL_PRESET.p3.runs]);
    expect(jobs.find((j) => j.id === 's101-SIM-A-3')?.scenarios.map((s) => s.kind)).toEqual(['fault.battery_capacity_fade', 'fault.inverter_efficiency_drop', 'fault.cell_imbalance', 'dq.stuck_sensor', 'dq.sample_loss']);
    expect(jobs.find((j) => j.id === 's101-SIM-B-5')?.scenarios.map((s) => s.kind)).toEqual(['fault.battery_capacity_fade']);
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
    related: [],
    controls: [],
    tallies: [],
    capacityStatuses: [],
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

  it('다른 탐지기 대상 주입의 부수 탐지 구간(related)에 든 finding은 오탐으로 세지 않는다', () => {
    const base = job();
    const excused = job({ related: [{ detectorId: 'ess.capacity_fade', assetIds: [2], startTs: T0 + 30 * DAY, endTs: T0 + 80 * DAY }] });
    // 설비 2의 35·42일 연속 오탐은 구간 안, 84일 오탐은 끝 + 허용 7일 안 → 모두 빠진다. 설비 1의 28일 오탐은 설비가 달라 남는다
    expect(scoreDetector([base], 'ess.capacity_fade').fp).toBe(3);
    expect(scoreDetector([excused], 'ess.capacity_fade').fp).toBe(1);
    const site = evalSite('SIM-A');
    const windows = relatedWindowsOf(site, [injection({ assetPath: 'SIM-A/PV1/INV02', relatedDetectors: ['pv.inverter_peer'] }), injection()]);
    const subtree = ['SIM-A/PV1/INV02', 'SIM-A/PV1/INV02/MPPT1', 'SIM-A/PV1/INV02/MPPT2'].map((path) => site.byPath.get(path)?.id);
    expect(windows).toEqual([{ detectorId: 'pv.inverter_peer', assetIds: subtree, startTs: T0 + 30 * DAY, endTs: T0 + 100 * DAY }]);
  });

  it('게이트: 평가할 주입이 없으면 실패로 본다', () => {
    const gates = evaluateGates([job()], scoreAll([job()]));
    expect(gates.find((g) => g.id === 'ess.capacity_fade.recall_5pct')?.pass).toBe(true);
    expect(gates.find((g) => g.id === 'ess.capacity_fade.fp_per_asset_month')?.pass).toBe(false);
    expect(gates.find((g) => g.id === 'el.voltage_rise.recall_20uvh')).toMatchObject({ value: null, pass: false });
  });
});

describe('용량 판정 가능 기간·SOC 상한 변경 대조군', () => {
  const summerDay = Date.parse('2026-06-01T00:00:00+09:00');
  const status = (day: number, assetId: number, value: CheckpointStatus['status']): CheckpointStatus => ({ ts: summerDay + day * DAY, assetId, status: value });

  it('여름 연속 insufficient 일수 = (마지막 − 처음) + 점검 간격, 사이트별 비율', () => {
    const statuses = [status(-7, 1, 'insufficient'), status(0, 1, 'insufficient'), status(7, 1, 'insufficient'), status(14, 1, 'ok'), status(21, 1, 'insufficient'), status(0, 2, 'ok')];
    const summerJob = job({ checkpointTs: [summerDay, summerDay + 7 * DAY], capacityStatuses: statuses });
    const [site] = capacityAvailability([summerJob]);
    // 5월 31일 점검은 여름이 아니다 → 여름 연속 구간은 0~7일(2개) = 7 + 7 = 14일
    expect(site).toMatchObject({ siteCode: 'SIM-A', checkpoints: 6, insufficient: 4, summerLongestInsufficientDays: 14 });
    expect(site?.insufficientRatio).toBeCloseTo(4 / 6, 12);
    expect(site?.summerInsufficientRatio).toBeCloseTo(3 / 5, 12);
  });

  it('SOC 상한 변경 대조군: ESS 설비 아래 랙마다 변경 7일 뒤 ok 점검 수(최소)와 변경 이후 finding 수', () => {
    const site = evalSite('SIM-C');
    const [rack1, rack2] = ['SIM-C/ESS1/RACK01', 'SIM-C/ESS1/RACK02'].map((path) => site.byPath.get(path)?.id ?? 0);
    const controlTs = T0 + 60 * DAY;
    const controlJob = job({
      siteCode: 'SIM-C',
      controls: [{ siteCode: 'SIM-C', assetPath: 'SIM-C/ESS1', kind: 'control.soc_upper_limit_change', startTs: controlTs, endTs: T0 + 126 * DAY, params: {}, confoundedDetectors: ['ess.capacity_fade'] }],
      capacityStatuses: [status(0, rack1 as number, 'ok'), { ts: controlTs + 7 * DAY, assetId: rack1 as number, status: 'ok' }, { ts: controlTs + 14 * DAY, assetId: rack1 as number, status: 'ok' }, { ts: controlTs + 14 * DAY, assetId: rack2 as number, status: 'ok' }, { ts: controlTs + 3 * DAY, assetId: rack2 as number, status: 'ok' }],
      detections: [{ ...detection(70, rack2 as number) }],
    });
    expect(socLimitControlScore([controlJob])).toMatchObject({ racks: 2, minOkCheckpoints: 1, falsePositives: 1 });
    expect(socLimitControlScore([job()])).toMatchObject({ racks: 0, minOkCheckpoints: null, falsePositives: 0 });
  });

  it('사이트별 부분 점수와 크기 상대오차 중앙값, 연계형 용량·여름·대조군 게이트', () => {
    const integrated = job({ siteCode: 'SIM-B', injections: [{ ...job().injections[0], injection: injection({ siteCode: 'SIM-B', assetPath: 'SIM-B/ESS1/RACK01' }) } as InjectionResult] });
    expect(scoreAtLeast([job(), integrated], 'ess.capacity_fade', 5, { siteCode: 'SIM-B' })).toMatchObject({ injections: 1, recall: 1 });
    expect(scoreAtLeast([job()], 'ess.capacity_fade', 5).magnitudeRelErrorMedian).toBeCloseTo(0.4 / 5, 12);
    const gates = evaluateGates([job(), integrated], scoreAll([job(), integrated]));
    expect(gates.find((g) => g.id === 'ess.capacity_fade.integrated_recall_5pct')).toMatchObject({ value: 1, pass: true });
    expect(gates.find((g) => g.id === 'ess.capacity_fade.summer_insufficient_run_days')).toMatchObject({ value: 0, comparator: '<', pass: true });
    expect(gates.find((g) => g.id === 'ess.capacity_fade.soc_limit_control_ok_checks')).toMatchObject({ value: null, pass: false });
  });
});

describe('평가 기록', () => {
  it('근거 창·주입 크기·상태 집계', () => {
    expect(evidenceWindows({ reference: { from: 1, to: 2 }, recent: { from: 3, to: 4 } })).toEqual({ referenceFrom: 1, referenceTo: 2, recentFrom: 3, recentTo: 4, bins: [] });
    const bins = [
      { key: 'chg|20', used: true, weight: 0.6, ref_from: 1, ref_to: 2, cur_from: 5, cur_to: 6 },
      { key: 'dis|25', used: false, weight: 0, ref_from: 3, ref_to: 4, cur_from: null, cur_to: null },
    ];
    expect(evidenceWindows({ reference: { from: 1, to: 4 }, recent: { from: 5, to: 6 }, bins })?.bins).toEqual([{ referenceFrom: 1, referenceTo: 2, recentFrom: 5, recentTo: 6, weight: 0.6 }]);
    expect(evidenceWindows({ reference: { from: 1 } })).toBeNull();
    expect(injectionMagnitude(injection({ kind: 'fault.elz_stack_degradation', params: { uvPerH: 20 } }))).toEqual({ magnitude: 20, unit: 'µV/h' });
    expect(injectionMagnitude(injection({ kind: 'fault.inverter_efficiency_drop', params: { pctPoints: 2 } }))).toEqual({ magnitude: 2, unit: '%p' });
    expect(injectionMagnitude(injection({ kind: 'fault.tank_leak', params: { kgPerDay: 0.05 } }))).toEqual({ magnitude: 0.05, unit: 'kg/일' });
    expect(injectionMagnitude(injection({ kind: 'fault.elz_sec_rise', params: { pct: 6, mode: 'stack' } }))).toEqual({ magnitude: 6, unit: '%' });
    const base: DetectorOutcome = { detectorId: 'el.voltage_rise', detectorVersion: '1', siteId: 1, assetId: 5, status: 'insufficient', findings: [], reason: '누적 운전시간 범위 부족: 12 h (100 h 필요)', configVersions: [], config: { scope: 'code_default', version: null, paramsHash: 'x', applied: [] } };
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
