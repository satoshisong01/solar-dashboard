// 가평 구성 평가 프리셋: 감압밸브 시트 누설 · 폐열회수 열교환기 오염 · 산소 중 수소(HTO) 상승 · 수질 악화 · 반입 기록 누락의 크기 스윕.
// 대상 사이트는 SIM-D(가평 복제) 한 곳이다. 서로 헷갈리게 하는 고장은 같은 순번에 두지 않는다 —
//   수질 악화(전도도)는 열교환기 교차누설 판별과 신호가 겹치므로 열교환기 오염과 다른 순번에 둔다.
//   반입 기록 누락은 물질수지 잔차를 크게 흔들어 다른 고장의 부수 탐지와 섞이므로 마지막 순번에만 둔다.
import type { Scenario } from './scenarios';

const SIM_D = 'SIM-D';

export const EVAL_GAPYEONG_PRESET = Object.freeze({
  /** 고장 시작일: 앞 120일은 기준선 */
  faultStartDay: 120,
  sweeps: {
    /** 감압밸브 시트 누설 [mbar/h] (경고 13 · 주의 130 — research-pressure) */
    prvSeatLeakMbarPerH: [20, 60, 150, null, null, null, null],
    /** 열교환기 오염: 같은 조건 UA 저하 [%] (경고 15 · 주의 25 — research-heat) */
    hxFoulingPct: [null, null, null, 20, 35, 50, null],
    /** 애노드 원가스 HTO 상승 [vol%p] (법정 압축금지선 2 vol%) */
    o2HtoPctPoints: [0.4, 0.8, 1.4, null, null, null, null],
    /** 순수 전도도 상승 [µS/cm] (전용 탐지기 없음 — 데이터만 쌓는다) */
    waterConductivityRise: [null, null, null, 1, 2, null, null],
    /** 반입 기록 누락 기간 [일] */
    deliveryUnloggedDays: [null, null, null, null, null, null, 14],
  },
  /** 고장 램프 [일] (수준형 고장이 목표 크기에 도달하는 기간) */
  rampDays: 30,
});

export type EvalGapyeongPreset = typeof EVAL_GAPYEONG_PRESET;

export interface GapyeongEvalMagnitudes {
  readonly prvSeatLeakMbarPerH: number | null;
  readonly hxFoulingPct: number | null;
  readonly o2HtoPctPoints: number | null;
  readonly waterConductivityRise: number | null;
  readonly deliveryUnloggedDays: number | null;
}

export function gapyeongMagnitudesAt(preset: EvalGapyeongPreset, i: number): GapyeongEvalMagnitudes {
  const { sweeps } = preset;
  return {
    prvSeatLeakMbarPerH: sweeps.prvSeatLeakMbarPerH[i] ?? null,
    hxFoulingPct: sweeps.hxFoulingPct[i] ?? null,
    o2HtoPctPoints: sweeps.o2HtoPctPoints[i] ?? null,
    waterConductivityRise: sweeps.waterConductivityRise[i] ?? null,
    deliveryUnloggedDays: sweeps.deliveryUnloggedDays[i] ?? null,
  };
}

/** 순번의 스윕 길이 (가장 긴 스윕) */
export const gapyeongRunCount = (preset: EvalGapyeongPreset = EVAL_GAPYEONG_PRESET): number => Math.max(...Object.values(preset.sweeps).map((values) => values.length));

const when = <T>(value: T | null, build: (v: T) => Scenario): Scenario[] => (value === null ? [] : [build(value)]);

export interface GapyeongRunScenarios {
  readonly magnitudes: GapyeongEvalMagnitudes;
  readonly siteCodes: readonly string[];
  readonly scenarios: readonly Scenario[];
}

/** 순번 i의 가평 구성 실행 (고장이 하나도 없는 순번은 사이트를 돌리지 않는다) */
export function gapyeongRunScenarios(preset: EvalGapyeongPreset, i: number): GapyeongRunScenarios {
  const m = gapyeongMagnitudesAt(preset, i);
  const startDay = preset.faultStartDay;
  const rampDays = preset.rampDays;
  const scenarios: Scenario[] = [
    ...when(m.prvSeatLeakMbarPerH, (mbarPerH) => ({ kind: 'fault.prv_seat_leak', site: SIM_D, barPerH: mbarPerH / 1000, startDay, rampDays })),
    ...when(m.hxFoulingPct, (pct) => ({ kind: 'fault.hx_fouling', site: SIM_D, pct, startDay, rampDays })),
    ...when(m.o2HtoPctPoints, (pctPoints) => ({ kind: 'fault.o2_purity_drift', site: SIM_D, pctPoints, startDay, rampDays })),
    ...when(m.waterConductivityRise, (uScmRise) => ({ kind: 'fault.water_quality', site: SIM_D, uScmRise, startDay, rampDays })),
    ...when(m.deliveryUnloggedDays, (days) => ({ kind: 'fault.delivery_unlogged', site: SIM_D, startDay: startDay + 60, days })),
  ];
  return { magnitudes: m, siteCodes: scenarios.length > 0 ? [SIM_D] : [], scenarios };
}
