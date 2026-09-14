// om.kpi_daily 키 → 리포트 표시 이름·단위·환산. 순수 모듈. 팩에는 환산한 값(표시 단위)을 넣는다.
import { KPI_KEYS } from '@/lib/analytics/kpi/daily';

export interface KpiDisplay {
  readonly label: string;
  readonly unit: string;
  /** 저장값 → 표시값 배율 (비율 → %는 100) */
  readonly scale: number;
  readonly digits: number;
  /** 날짜별 값을 더해 기간 합계를 낼 수 있는가 (에너지량) */
  readonly additive: boolean;
}

export const KPI_DISPLAY: Readonly<Record<string, KpiDisplay>> = {
  [KPI_KEYS.pv_kwh]: { label: '태양광 발전량', unit: 'kWh', scale: 1, digits: 0, additive: true },
  [KPI_KEYS.specific_yield_kwh_kwp]: { label: '비발전량(일)', unit: 'kWh/kWp', scale: 1, digits: 2, additive: false },
  [KPI_KEYS.inverter_peer_ratio]: { label: '인버터 동종 대비 비율', unit: '%', scale: 100, digits: 1, additive: false },
  [KPI_KEYS.availability]: { label: '인버터 가용률', unit: '%', scale: 100, digits: 1, additive: false },
  [KPI_KEYS.ess_rte]: { label: 'ESS 왕복효율', unit: '%', scale: 100, digits: 1, additive: false },
  [KPI_KEYS.elz_sec_kwh_per_kg]: { label: '전해조 비에너지 소비', unit: 'kWh/kg', scale: 1, digits: 1, additive: false },
  [KPI_KEYS.elz_v_cell_ref]: { label: '전해조 기준 셀 전압', unit: 'V', scale: 1, digits: 3, additive: false },
  [KPI_KEYS.fc_kg_per_mwh]: { label: '연료전지 수소 소비', unit: 'kg/MWh', scale: 1, digits: 1, additive: false },
  [KPI_KEYS.fc_v_cell_ref]: { label: '연료전지 기준 셀 전압', unit: 'V', scale: 1, digits: 3, additive: false },
};

/** 리포트 KPI 절 문장으로 쓰는 지표 (나머지는 표에만) */
export const KPI_TEXT_KEYS: readonly string[] = [KPI_KEYS.pv_kwh, KPI_KEYS.specific_yield_kwh_kwp, KPI_KEYS.availability, KPI_KEYS.ess_rte, KPI_KEYS.elz_sec_kwh_per_kg, KPI_KEYS.fc_kg_per_mwh];

export function kpiDisplay(key: string): KpiDisplay {
  return KPI_DISPLAY[key] ?? { label: key, unit: '', scale: 1, digits: 2, additive: false };
}

/** 에너지 요약 항목 표시 */
export const ENERGY_LABELS = {
  pvKwh: { label: '태양광 발전량', unit: 'kWh' },
  essChargeKwh: { label: 'ESS 충전량', unit: 'kWh' },
  essDischargeKwh: { label: 'ESS 방전량', unit: 'kWh' },
  h2Kg: { label: '수소 생산량', unit: 'kg' },
  fcKwh: { label: '연료전지 발전량', unit: 'kWh' },
} as const;

export type EnergyKey = keyof typeof ENERGY_LABELS;
export const ENERGY_KEYS = Object.keys(ENERGY_LABELS) as EnergyKey[];
