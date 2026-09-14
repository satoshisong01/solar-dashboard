// lib/sim ↔ lib/analytics 인터페이스 계약: 정답의 고장모드·탐지기 id와 메모리 모드 메트릭이 분석 라이브러리와 맞는지 확인한다.
import { describe, expect, it } from 'vitest';
import { P2_DETECTORS } from '@/lib/analytics/detectors';
import { DETECTOR_METRICS } from './memory';
import { presetScenarios } from './presets';
import { buildTruth } from './truth';

const FROM = Date.parse('2026-05-18T00:00:00+09:00');
const TO = FROM + 120 * 86_400_000;
const ALL = ['SIM-A', 'SIM-B', 'SIM-C'];

/** 탐지기 입력 맵에 합쳐 넣는 상위·형제 설비 종류 (연료전지 스택 ← 연료전지 설비·블로워 등) */
const MERGED_CLASSES: Readonly<Record<string, readonly string[]>> = {
  'ess.rack': ['ess.rack'],
  'pv.inverter': ['pv.inverter', 'wx.station'],
  'h2.elz.stack': ['h2.elz.stack', 'h2.elz'],
  'fc.stack': ['fc.stack', 'fc.plant', 'fc.blower'],
};

describe('lib/sim ↔ lib/analytics 계약', () => {
  it('고장 주입 정답의 탐지기 id와 고장모드는 분석 라이브러리 P2 탐지기와 같다', () => {
    const truth = buildTruth({ siteCodes: ALL, from: FROM, to: TO, scenarios: presetScenarios('demo120', ALL, { fromMs: FROM, toMs: TO }) });
    const byId = new Map(P2_DETECTORS.map((d) => [d.id, d.failureMode as string]));
    const faults = truth.injections.filter((i) => i.expectedDetectors.length > 0);

    expect(faults.length).toBeGreaterThan(0);
    for (const injection of faults) {
      for (const detectorId of injection.expectedDetectors) {
        expect(byId.has(detectorId)).toBe(true);
        expect(injection.expectedFailureModes).toContain(byId.get(detectorId));
      }
    }
  });

  it('메모리 모드 탐지기 메트릭은 P2 탐지기가 요구하는 메트릭을 모두 담는다', () => {
    for (const detector of P2_DETECTORS) {
      for (const classKey of detector.requires.assetClass) {
        const available = new Set((MERGED_CLASSES[classKey] ?? [classKey]).flatMap((key) => DETECTOR_METRICS[key] ?? []));
        expect(detector.requires.metrics.filter((metric) => !available.has(metric))).toEqual([]);
      }
    }
  });
});
