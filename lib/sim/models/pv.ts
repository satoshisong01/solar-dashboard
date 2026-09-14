// 태양광 어레이 + 인버터 근사 모델 (상태 없음, 순수 함수).
// POA → 모듈온도(NOCT) → DC 최대전력(온도계수·오염) → MPPT 전압·전류 → 인버터 효율 곡선·클리핑 → AC.
import { clamp } from '../math';
import { converterLossKw, type ConverterLossModel } from './common';

/** 550 Wp 모듈 근사값 (데이터시트 범위 안의 추정) */
export const PV_MODULE = Object.freeze({
  pmaxW: 550,
  vmpV: 41.96,
  vocV: 49.9,
  gammaPmpPerC: -0.0035,
  betaVmpPerC: -0.0031,
  betaVocPerC: -0.0027,
  noctC: 45,
});
export const MODULES_PER_STRING = 19;

const INVERTER_LOSS: ConverterLossModel = { noLoad: 0.004, linear: 0.012, quadratic: 0.008 };
/** 배선·미스매치 손실 */
const DC_LOSS_FRACTION = 0.03;
/** 이 일사 미만이면 인버터가 잠든다(off) */
const SLEEP_POA_W_M2 = 1;
/** DC 가용전력이 정격의 이 비율 미만이면 대기(standby) */
const STANDBY_FRACTION = 0.005;

export type InverterMode = 'off' | 'standby' | 'running' | 'fault';

export interface InverterRating {
  readonly acKw: number;
  readonly dcKwp: number;
}

export interface InverterConditions {
  readonly poa: number;
  readonly ambientC: number;
  /** 오염 손실 비율 (0~1) */
  readonly soiling: number;
  /** 효율 절대 저하량 (0.01 = 1%p) */
  readonly efficiencyDrop: number;
  /** 출력 제한 설정값 (%) */
  readonly limitPct: number;
  readonly tripped: boolean;
}

export interface InverterOperatingPoint {
  readonly mode: InverterMode;
  readonly acKw: number;
  readonly dcKw: number;
  readonly dcVoltageV: number;
  readonly dcCurrentA: number;
  readonly efficiency: number;
  readonly moduleTempC: number;
  readonly clipped: boolean;
}

/** NOCT 근사: T_mod = T_amb + (NOCT − 20)/800 × POA */
export function moduleTemperatureC(poa: number, ambientC: number, noctC = PV_MODULE.noctC): number {
  return ambientC + ((noctC - 20) / 800) * Math.max(0, poa);
}

/** 인버터 효율(0~1): 저부하에서 낮고 정격 70% 부근에서 최대(약 97.7%) */
export function inverterEfficiency(dcKw: number, acRatedKw: number): number {
  if (dcKw <= 0) return 0;
  return clamp((dcKw - converterLossKw(INVERTER_LOSS, acRatedKw, dcKw)) / dcKw, 0, 1);
}

/** 온도·일사에 따른 DC 최대전력 [kW] */
export function maxPowerDcKw(rating: InverterRating, poa: number, moduleTempC: number, soiling: number): number {
  const temperatureFactor = 1 + PV_MODULE.gammaPmpPerC * (moduleTempC - 25);
  return (
    rating.dcKwp * (Math.max(0, poa) / 1000) * temperatureFactor * (1 - DC_LOSS_FRACTION) * (1 - clamp(soiling, 0, 1))
  );
}

function stringVoltageV(poa: number, moduleTempC: number, kind: 'mpp' | 'open'): number {
  const irradianceFactor = 1 + 0.025 * Math.log(Math.max(poa, 1) / 1000); // 저일사 전압 저하
  const [moduleV, beta] = kind === 'mpp' ? [PV_MODULE.vmpV, PV_MODULE.betaVmpPerC] : [PV_MODULE.vocV, PV_MODULE.betaVocPerC];
  return MODULES_PER_STRING * moduleV * (1 + beta * (moduleTempC - 25)) * irradianceFactor;
}

/** AC 목표를 내기 위한 DC 입력 (고정점 반복) */
function dcForAc(acKw: number, efficiencyAt: (dcKw: number) => number): number {
  let dcKw = acKw;
  for (let i = 0; i < 8; i += 1) {
    const efficiency = efficiencyAt(dcKw);
    if (efficiency <= 0) return dcKw;
    dcKw = acKw / efficiency;
  }
  return dcKw;
}

export function simulateInverter(rating: InverterRating, conditions: InverterConditions): InverterOperatingPoint {
  const moduleTempC = moduleTemperatureC(conditions.poa, conditions.ambientC);
  const idle = (mode: InverterMode, dcVoltageV: number): InverterOperatingPoint => ({
    mode,
    acKw: 0,
    dcKw: 0,
    dcVoltageV,
    dcCurrentA: 0,
    efficiency: 0,
    moduleTempC,
    clipped: false,
  });

  if (conditions.poa < SLEEP_POA_W_M2) return idle('off', 0);
  const openCircuitV = stringVoltageV(conditions.poa, moduleTempC, 'open');
  if (conditions.tripped) return idle('fault', openCircuitV);
  const mppKw = maxPowerDcKw(rating, conditions.poa, moduleTempC, conditions.soiling);
  if (mppKw < rating.acKw * STANDBY_FRACTION) return idle('standby', openCircuitV);

  const efficiencyAt = (dcKw: number) => Math.max(0, inverterEfficiency(dcKw, rating.acKw) - conditions.efficiencyDrop);
  const limitKw = (rating.acKw * clamp(conditions.limitPct, 0, 100)) / 100;
  const mppAcKw = mppKw * efficiencyAt(mppKw);
  const clipped = mppAcKw > limitKw;
  const dcKw = clipped ? Math.min(mppKw, dcForAc(limitKw, efficiencyAt)) : mppKw;
  const acKw = clipped ? limitKw : mppAcKw;
  const mppV = stringVoltageV(conditions.poa, moduleTempC, 'mpp');
  // 클리핑하면 MPPT가 동작점을 개방전압 쪽으로 옮겨 DC 입력을 줄인다
  const dcVoltageV = clipped ? mppV + (openCircuitV - mppV) * 0.8 * (1 - dcKw / mppKw) : mppV;

  return {
    mode: 'running',
    acKw,
    dcKw,
    dcVoltageV,
    dcCurrentA: (dcKw * 1000) / dcVoltageV,
    efficiency: dcKw > 0 ? acKw / dcKw : 0,
    moduleTempC,
    clipped,
  };
}
