// 적재 스크립트(sim:backfill)용 시나리오 프리셋. 적재 구간에 비례한 날짜의 KST 시각에 배치한다.
import { KST_OFFSET_MS, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import type { Scenario } from './scenarios';

export const SCENARIO_PRESETS = ['healthy', 'dq'] as const;
export type ScenarioPreset = (typeof SCENARIO_PRESETS)[number];

/** dq 프리셋의 구간 배치가 서로 겹치지 않고 적재 구간 안에 들어가는 최소 일수 */
export const DQ_MIN_DAYS = 3;
const DQ_REQUIRED_SITES = ['SIM-A', 'SIM-B'] as const;
const HOUR_S = 3_600;

export interface PresetWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

const kstDayStart = (ms: number): number => Math.floor((ms + KST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - KST_OFFSET_MS;

/** 구간의 fraction 지점이 속한 KST 날짜의 kstHour 시각. 구간 밖이면 하루 당기거나 민다. */
function placeAt(window: PresetWindow, fraction: number, kstHour: number): number {
  const pivot = window.fromMs + (window.toMs - window.fromMs) * fraction;
  const candidate = kstDayStart(pivot) + kstHour * MS_PER_HOUR;
  if (candidate < window.fromMs) return candidate + MS_PER_DAY;
  if (candidate >= window.toMs) return candidate - MS_PER_DAY;
  return candidate;
}

/**
 * 데이터 품질 프리셋 (설계 §5.5):
 * - 선택한 모든 사이트 중복 배치 5% (저장값이 바뀌지 않으므로 대조군 SIM-C에도 적용)
 * - SIM-A: 일사계(WX1/POA) 8시간 고착, +200초 시계 오차 12시간 구간
 * - SIM-B: 게이트웨이 6시간 단절 후 역순 백필, 저장탱크 압력 스파이크(하루 1회꼴), 수소 누출 1차 경보 1회
 * 값을 바꾸는 시나리오는 대조군 SIM-C에 넣지 않는다.
 */
function dqScenarios(siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  const missing = DQ_REQUIRED_SITES.filter((code) => !siteCodes.includes(code));
  if (missing.length > 0) throw new Error(`dq 시나리오에는 ${DQ_REQUIRED_SITES.join('·')}가 필요합니다 (빠진 사이트: ${missing.join(', ')})`);
  if (window.toMs - window.fromMs < DQ_MIN_DAYS * MS_PER_DAY) throw new Error(`dq 시나리오는 ${DQ_MIN_DAYS}일 이상 적재할 때만 쓸 수 있습니다`);

  return [
    ...siteCodes.map((site): Scenario => ({ kind: 'dq.duplicate_batches', site, ratio: 0.05 })),
    { kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA', start: placeAt(window, 0.2, 9), durationS: 8 * HOUR_S },
    { kind: 'dq.gateway_outage', site: 'SIM-B', start: placeAt(window, 0.4, 10), durationS: 6 * HOUR_S },
    { kind: 'dq.clock_skew', site: 'SIM-A', skewS: 200, start: placeAt(window, 0.6, 18), durationS: 12 * HOUR_S },
    { kind: 'dq.spike', site: 'SIM-B', sourceKey: 'H2BANK1/TANK1/P', perDay: 1 },
    { kind: 'safety.h2_leak_alarm', site: 'SIM-B', at: placeAt(window, 0.8, 14) + 30 * MS_PER_MINUTE },
  ];
}

export function presetScenarios(preset: ScenarioPreset, siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  switch (preset) {
    case 'healthy':
      return [];
    case 'dq':
      return dqScenarios(siteCodes, window);
  }
}
