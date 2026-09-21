// 열화 파라미터 hook: 물리 모델이 스텝마다 설비별 열화 값을 묻는 창구와, 시작일·램프·크기로 만드는 시간 함수.
import { clamp, MS_PER_DAY } from './math';

/**
 * 열화 파라미터. baseline은 건강한 설비의 기본값이다.
 * - 비율/일, µV/h, kg/일 같은 "율"은 모델이 시간에 따라 적분한다.
 * - cellImbalance·efficiencyDrop·wear 같은 "수준"은 그 시각 값을 그대로 쓴다.
 */
export const DEGRADATION_PARAMS = Object.freeze({
  /** 랙 용량 감소율 [비율/일] (0.00005 ≈ 연 1.8%) */
  'battery.capacityFadePerDay': { classKey: 'ess.rack', baseline: 0.000_05 },
  /** 최강·최약 셀 SOC 차이 [비율] */
  'battery.cellImbalance': { classKey: 'ess.rack', baseline: 0.01 },
  /** 최고·최저 셀 전압 산포 추가분 [mV] (SOC와 무관, 밸런싱 불량) */
  'battery.cellSpreadMv': { classKey: 'ess.rack', baseline: 0 },
  /** 인버터 효율 절대 저하 [비율, 0.01 = 1%p] */
  'inverter.efficiencyDrop': { classKey: 'pv.inverter', baseline: 0 },
  /** 전해 스택 셀당 전압 상승률 [µV/h] */
  'elz.degradationUvPerH': { classKey: 'h2.elz.stack', baseline: 4 },
  /** 연료전지 셀당 전압 감쇠율 [µV/h] */
  'fc.voltageDecayUvPerH': { classKey: 'fc.stack', baseline: 6 },
  /** 저장용기 누설 [kg/일] (용기별) */
  'storage.leakKgPerDay': { classKey: 'h2.storage.tank', baseline: 0 },
  /** 인버터 어레이 오염 누적률 [비율/일] (강우 시 초기화) */
  'pv.soilingPerDay': { classKey: 'pv.inverter', baseline: 0.001 },
  /** 블로워 마모 [0~0.9] — 같은 유량에 전력 1/(1−wear)배 */
  'blower.wear': { classKey: 'fc.blower', baseline: 0 },
  // P3
  /** 끈적한 오염층 누적률 [비율/일] — 약한 비로는 씻기지 않고 강한 비·세척에서만 초기화 */
  'pv.stickySoilingPerDay': { classKey: 'pv.inverter', baseline: 0 },
  /** 인버터 냉각 성능 저하 [비율] — 방열판 온도 상승폭 × (1 + 값) (냉각팬 고장 1) */
  'inverter.coolingLoss': { classKey: 'pv.inverter', baseline: 0 },
  /** 랙 내부저항 증가 [비율] (0.45 = +45%) */
  'battery.resistanceGrowth': { classKey: 'ess.rack', baseline: 0 },
  /** 정류기 AC 입력 추가 손실 [비율] — 같은 DC 출력에 AC 입력 × (1 + 값) */
  'elz.rectifierLossExtra': { classKey: 'h2.elz.rectifier', baseline: 0 },
  /** 패러데이 효율 추가 손실 [비율] — 같은 전류에 수소 × (1 − 값) */
  'elz.faradaicLoss': { classKey: 'h2.elz.stack', baseline: 0 },
  /** 셀당 전압 추가 상승 [V] (수준, 운전시간 열화와 별도) */
  'elz.extraCellVoltageV': { classKey: 'h2.elz.stack', baseline: 0 },
  /** 수소측 퍼지·건조기 재생 빈도 추가 비율 [비율] — 퍼지 횟수와 재생 손실이 함께 (1 + 값)배 */
  'elz.purgeRateExtra': { classKey: 'h2.elz.dryer', baseline: 0 },
  /** 전해조 수소 유량계 이득 [배] (1 = 정확, 1.02 = 2% 과대 계량) */
  'meter.h2FlowGain': { classKey: 'h2.elz', baseline: 1 },
  /** 압축기 밸브 마모 [비율] — 같은 압력비에서 비일(kJ/kg) × (1 + 값), 토출 온도 상승 */
  'compressor.valveWear': { classKey: 'h2.compressor', baseline: 0 },
  /** 다이어프램·씰 누설 [bar] — 운전 중 누설 감지 포트 압력 상승분 */
  'compressor.sealLeakBar': { classKey: 'h2.compressor', baseline: 0 },
  /** 공기 필터 막힘 [비율] — 같은 유량에 블로워 전력 × (1 + 값) */
  'blower.filterClog': { classKey: 'fc.blower', baseline: 0 },
  // 가평 구성 부속 계통 (산소·폐열·수처리·감압·반입)
  /** 감압밸브 시트 누설에 따른 무유동 하류 압력 상승률 [bar/h] */
  'prv.seatLeakBarPerH': { classKey: 'h2.prv', baseline: 0 },
  /** 열교환기 오염 [비율] — 같은 조건에서 UA × (1 − 값) */
  'hx.fouling': { classKey: 'hx.recovery', baseline: 0 },
  /** 순수 전도도 상승 [µS/cm] — 수지 파과·교차누설 */
  'water.conductivityRise': { classKey: 'h2.elz.water', baseline: 0 },
  /** 애노드 원가스 HTO 추가 상승 [vol%] — 멤브레인 크로스오버 증가 (법정 압축금지선 2%) */
  'o2.htoRise': { classKey: 'o2.plant', baseline: 0 },
  /** 하역 계량기 이득 [배] (1 = 정확, 0 = 반입 기록 누락 — 실제로는 들어왔는데 계량이 늘지 않는다) */
  'delivery.meterGain': { classKey: 'h2.delivery', baseline: 1 },
});

export type DegradationParam = keyof typeof DEGRADATION_PARAMS;

/** 시각 [epoch ms]과 기본값을 받아 그 시각의 파라미터 값을 돌려준다. */
export type DegradationHook = (tMs: number, baseline: number) => number;

/** P2 고장 주입 인터페이스: 열화 파라미터를 시간 함수로 덮어쓴다. */
export interface FaultScenario {
  readonly kind: 'fault';
  readonly site: string;
  readonly param: DegradationParam;
  /** 설비 코드. 생략하면 사이트 안 해당 종류 설비 전부 */
  readonly asset?: string;
  readonly value: DegradationHook;
}

export interface DegradationResolver {
  value(param: DegradationParam, assetCode: string, tMs: number): number;
}

/** 설비 지정 hook > 사이트 전체 hook > 기본값. 같은 대상이 여럿이면 나중 것이 이긴다. */
export function createDegradationResolver(faults: readonly FaultScenario[]): DegradationResolver {
  return {
    value(param, assetCode, tMs) {
      const baseline = DEGRADATION_PARAMS[param].baseline;
      const hook =
        faults.findLast((f) => f.param === param && f.asset === assetCode) ??
        faults.findLast((f) => f.param === param && f.asset === undefined);
      if (!hook) return baseline;
      const value = hook.value(tMs, baseline);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${param}(${assetCode}) hook이 잘못된 값을 돌려줬습니다: ${value}`);
      return value;
    },
  };
}

/** 시작 전 0, 시작 후 rampMs 동안 0→1로 선형 증가, 이후 1. rampMs가 0이면 시작 시각에 계단. */
export function rampFraction(tMs: number, startMs: number, rampMs: number): number {
  if (tMs < startMs) return 0;
  if (rampMs <= 0) return 1;
  return clamp((tMs - startMs) / rampMs, 0, 1);
}

/** 수준 hook: 시작일부터 rampMs에 걸쳐 기본값 + magnitude까지 오르고 그대로 유지한다. */
export const levelRampHook =
  (startMs: number, rampMs: number, magnitude: number): DegradationHook =>
  (tMs, baseline) =>
    baseline + magnitude * rampFraction(tMs, startMs, rampMs);

/** 수준 hook: 시작일부터 기본값 + perDay × 경과 일수로 계속 커진다. */
export const linearGrowthHook =
  (startMs: number, perDay: number): DegradationHook =>
  (tMs, baseline) =>
    baseline + (perDay * Math.max(0, tMs - startMs)) / MS_PER_DAY;

/** 율 hook: [startMs, endMs) 동안만 기본값에 extraRate를 더한다 (그 구간에 extraRate × 길이만큼 추가 누적). */
export const extraRateHook =
  (startMs: number, endMs: number, extraRate: number): DegradationHook =>
  (tMs, baseline) =>
    tMs >= startMs && tMs < endMs ? baseline + extraRate : baseline;

/** 수준 hook: [startMs, endMs) 동안 rampMs에 걸쳐 기본값 + magnitude까지 오르고, endMs부터 기본값으로 돌아간다 (부품 교체로 회복). */
export const levelRampUntilHook =
  (startMs: number, rampMs: number, magnitude: number, endMs: number): DegradationHook =>
  (tMs, baseline) =>
    tMs >= endMs ? baseline : baseline + magnitude * rampFraction(tMs, startMs, rampMs);

/** 율 hook: 시작일부터 기본값 대신 rate를 쓴다 (운전시간 열화율처럼 전체 기울기를 지정할 때). */
export const rateFromHook =
  (startMs: number, rate: number): DegradationHook =>
  (tMs, baseline) =>
    tMs >= startMs ? rate : baseline;
