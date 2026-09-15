// EvidencePack P3 조각: 탐지기 8종 근거 요약과 에너지·수소 원장 기간 합 (순수 타입 모듈).
// 원시 시계열·일 원장 행은 넣지 않는다 — 문장에 쓰는 수치와 ≤120점 근거 요약 시계열만.
import type { PackCheck, PackSeries } from './pack-types';

/** el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth */
export interface RisePackEvidence {
  readonly kind: 'rise';
  readonly subject: string;
  readonly countWord: string;
  /** 비교에 쓴 bin 라벨 (앞 3개 + '외 N개') — 숫자가 섞여 이름 토큰으로 쓴다 */
  readonly conditionLabel: string;
  readonly binCount: number;
  readonly nRef: number;
  readonly nCur: number;
  /** 추세 기울기 (표시 단위 trendUnit) */
  readonly trendSlope: number | null;
  readonly trendCiLow: number | null;
  readonly trendCiHigh: number | null;
  /** '%/1000 h' · '%/월' (이름 토큰) */
  readonly trendUnit: string;
  /** '누적 운전시간' · '경과일' */
  readonly trendAxis: string;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface TankLeakPackEvidence {
  readonly kind: 'tank_leak';
  readonly recentHolds: number;
  readonly referenceHolds: number;
  readonly medianHoldHours: number | null;
  /** 'NIST 상태식' · 'Abel–Noble 근사식' (이름 토큰) */
  readonly eosLabel: string;
  readonly pctPerDay: number | null;
  readonly noiseSigmaKgPerDay: number | null;
  readonly thresholdKgPerDay: number | null;
  readonly safetyCategory: boolean;
  readonly safetyKgPerDay: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface MassBalancePackEvidence {
  readonly kind: 'mass_balance';
  readonly recentDays: number;
  readonly referenceDays: number;
  readonly referenceMedianPct: number | null;
  readonly recentMedianKg: number | null;
  /** CUSUM 경보일 KST 0시 (없으면 null) */
  readonly alarmDay: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface SoilingPackEvidence {
  readonly kind: 'soiling';
  readonly ratePctPerDay: number | null;
  readonly rateCiLow: number | null;
  readonly rateCiHigh: number | null;
  readonly clearDays: number;
  /** 마지막 복원일 KST 0시 (복원이 없으면 null) */
  readonly lastResetDay: number | null;
  /** '세척' · '강우·복원' (이름 토큰, 없으면 null) */
  readonly lastResetLabel: string | null;
  readonly cumulativeLossKwh: number | null;
  readonly dailyLossKwh: number | null;
  readonly lossValueKrw: number | null;
  readonly smpKrwPerKwh: number | null;
  readonly cleaningCostKrw: number | null;
  /** 누적 손실액 ÷ 세척비 [%] */
  readonly shareOfCleaningPct: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface ThermalPackEvidence {
  readonly kind: 'thermal';
  readonly days: number;
  readonly derateDays: number;
  readonly derateHours: number;
  readonly lossKwh: number;
  /** 저감 판정 방열판 온도 [°C] = 저감 시작 − 여유 */
  readonly hotC: number | null;
  readonly gapPct: number | null;
  readonly refBinDerateH: number | null;
  readonly curBinDerateH: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export type P3PackEvidence = RisePackEvidence | TankLeakPackEvidence | MassBalancePackEvidence | SoilingPackEvidence | ThermalPackEvidence;

export interface PackLedgerEnergy {
  readonly pvKwh: number;
  readonly essDischargeKwh: number;
  readonly fcKwh: number;
  readonly gridImportKwh: number;
  readonly siteAuxKwh: number;
  readonly essChargeKwh: number;
  readonly electrolyzerKwh: number;
  readonly compressorKwh: number;
  readonly gridExportKwh: number;
  readonly unmeteredKwh: number;
}

export interface PackLedgerHydrogen {
  /** 생산·소비·잔차가 모두 있어 합계에 들어간 날 */
  readonly daysUsed: number;
  readonly producedKg: number;
  readonly fcConsumedKg: number;
  readonly storedDeltaKg: number;
  readonly ventedEstKg: number;
  readonly residualKg: number;
  readonly residualPct: number | null;
}

export interface PackLedgerKpis {
  readonly elzSecKwhPerKg: number | null;
  readonly fcKgPerMwh: number | null;
  readonly p2pEfficiencyPct: number | null;
  readonly renewableSharePct: number | null;
  readonly gridSharePct: number | null;
}

export interface PackPvLossItem {
  readonly bucket: string;
  readonly label: string;
  readonly kwh: number;
  readonly pctOfExpected: number | null;
}

export interface PackPvLoss {
  readonly daysWithBreakdown: number;
  readonly expectedKwh: number;
  readonly actualKwh: number;
  readonly items: readonly PackPvLossItem[];
}

/** 에너지·수소 체인 원장 기간 합 (om.site_energy_daily, 끝난 날만) */
export interface PackEnergyLedger {
  readonly days: number;
  /** 첫날·마지막 날 KST 0시 */
  readonly firstDay: number;
  readonly lastDay: number;
  /** 'pool_hourly@1' (이름 토큰) */
  readonly allocVersion: string;
  readonly calcVersions: readonly string[];
  readonly energy: PackLedgerEnergy;
  /** 수소 원장 값이 모두 있는 날이 없으면 null */
  readonly hydrogen: PackLedgerHydrogen | null;
  readonly kpis: PackLedgerKpis;
  /** PV 미활용 분해가 있는 날이 없으면 null */
  readonly pvLoss: PackPvLoss | null;
  readonly unmeteredRatioPct: number | null;
  /** 수소 원장 완결성 기준 미만인 날 */
  readonly lowH2CompletenessDays: number;
}
