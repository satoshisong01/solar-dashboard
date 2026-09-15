// 사이트 에너지·수소 체인 원장 (om.site_energy_daily 한 행 = SiteEnergyDay 하나) 입력·출력 타입.
// 순수 모듈이다 ('server-only' 금지). 입력 로드(m_1h·자산 조회)는 다음 단계의 load 계층이 맡는다.
// 청정수소 인증 공식 산정이 아니다 (설계 §9 체인 원장 리스크).

export const ALLOC_VERSION = 'pool_hourly@1';
export const LEDGER_CALC_VERSION = 'ledger@1';

/** 원장 계산에 필요한 설비 (om.asset 한 행) */
export interface LedgerAsset {
  readonly id: number;
  /** 사이트 안 경로 (예: PV1/INV01) */
  readonly code: string;
  readonly classKey: string;
  readonly nameplate: Readonly<Record<string, unknown>>;
}

/**
 * om.m_1h 한 행 + 설비·메트릭·포인트 주기. lib/analytics/pipeline/kpis.ts의 HourlyPointRow를 그대로 넣을 수 있다.
 * 값은 정규 단위(kW·kg/h·bar·°C·%)다. 전력 메트릭의 한 시간 에너지 = integral ?? avg × 1 h.
 */
export interface LedgerHourRow {
  readonly assetId: number;
  readonly metricKey: string;
  /** UTC 정시 (epoch ms). KST는 UTC+9 정수 시간이라 KST 날짜 경계와 맞는다 */
  readonly hourStart: number;
  readonly periodS: number;
  readonly n: number;
  readonly nGood: number;
  readonly avg: number | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly sum?: number | null;
  /** 시간 적분 [단위·h]. m_1h에 열이 없으면 생략 → avg × 1 h (결측 샘플은 평균값으로 채운 것과 같다) */
  readonly integral?: number | null;
}

/** 공급 노드: 태양광 AC, ESS 방전, 연료전지 AC, 계통 수전 */
export const SUPPLY_NODES = ['pv', 'ess_discharge', 'fc', 'grid_import'] as const;
/** 수요 노드: 보조부하·잔여, ESS 충전, 전해조(정류기 입력), 압축기, 계통 송전 */
export const DEMAND_NODES = ['site_aux', 'ess_charge', 'electrolyzer', 'compressor', 'grid_export'] as const;
/** 계측 불일치를 드러내는 가상 노드 (공급 < 수요면 공급 쪽, 공급 > 수요면 수요 쪽) */
export const UNMETERED = 'unmetered';

export type SupplyNode = (typeof SUPPLY_NODES)[number] | typeof UNMETERED;
export type DemandNode = (typeof DEMAND_NODES)[number] | typeof UNMETERED;

export interface EnergyFlow {
  readonly from: SupplyNode;
  readonly to: DemandNode;
  readonly kwh: number;
}

/** 보조부하 산정 방식: residual = 공급 − 계측 수요 잔여를 보조부하로 봄 / estimate = params.siteAuxKw 추정값, 잔여는 unmetered */
export type AuxBasis = 'residual' | 'estimate';
/** 전해조 전력 기준: 정류기 AC 입력 / 전해조 설비 전체 AC(BoP 포함) */
export type ElzPowerBasis = 'rectifier_input' | 'system_total';

/** 노드별 하루 합계 [kWh]. electrolyzer_system은 SEC·P2P 분자(설비 전체 AC, 없으면 정류기 입력) */
export interface EnergyTotals {
  readonly pv: number;
  readonly ess_discharge: number;
  readonly fc: number;
  readonly grid_import: number;
  readonly site_aux: number;
  readonly ess_charge: number;
  readonly electrolyzer: number;
  readonly electrolyzer_system: number;
  readonly compressor: number;
  readonly grid_export: number;
  readonly unmetered_supply: number;
  readonly unmetered_demand: number;
}

export type H2ProducedMethod = 'meter' | 'faraday_estimate';
export type VentedMethod = 'params' | 'not_estimated';

export interface H2Ledger {
  readonly produced: number | null;
  readonly fc_consumed: number | null;
  readonly stored_delta: number | null;
  readonly vented_est: number | null;
  readonly residual: number | null;
  /** residual / max(produced, fc_consumed, params.residualFloorKg) × 100 [%] */
  readonly residual_pct: number | null;
  readonly method: {
    readonly produced: H2ProducedMethod | null;
    readonly fc_consumed: 'meter' | null;
    readonly stored_delta: string | null;
    readonly vented: VentedMethod;
  };
  /** 물질수지 판별 체크 보조값 (h2chain.mass_balance_gap): 스택 전류 이론 생산량 [kg, η_F = 1], 퍼지 횟수 증가분, 저장용기 가스 온도 끝 − 시작 평균 [°C] */
  readonly aux: {
    readonly faraday_expected: number | null;
    readonly purge_count: number | null;
    readonly tank_temp_delta_c: number | null;
  };
}

/** PV 미활용 손실 버킷 [kWh]. 합계 = expected − actual (unexplained가 나머지를 받는다, 음수 가능) */
export interface PvLossBreakdown {
  readonly expected: number;
  readonly actual: number;
  readonly outage: number;
  readonly ess_full: number;
  readonly curtailment: number;
  readonly clipping: number;
  readonly derating: number;
  readonly soiling_est: number;
  readonly unexplained: number;
}

export type PvLossBucket = Exclude<keyof PvLossBreakdown, 'expected' | 'actual'>;

export interface SiteEnergyDq {
  readonly energy: {
    /** 원천 메트릭별 완결성 (Σ n_good / 기대 샘플 수, 해당 설비가 없으면 null) */
    readonly completeness: Readonly<Record<string, number | null>>;
    readonly aux_basis: AuxBasis;
    /** residual 방식에서 보조부하로 넘긴 잔여 [kWh] */
    readonly aux_residual_kwh: number;
    readonly unmetered_kwh: number;
    /** unmetered kWh / 풀 전체 kWh (풀이 0이면 null) */
    readonly unmetered_ratio: number | null;
    readonly elz_flow_basis: ElzPowerBasis | null;
    readonly elz_energy_basis: ElzPowerBasis | null;
  };
  readonly h2: {
    readonly completeness: number | null;
    readonly purge_count_missing: boolean;
  };
  readonly pv: {
    readonly completeness: number | null;
    readonly pr_ref: number | null;
    readonly pr_ref_method: PrReferenceMethod | null;
    readonly soiling_status: 'estimated' | 'not_estimated';
    /** 일사 있는 시간 중 모듈 온도로 보정한 비율 */
    readonly temp_corrected_ratio: number | null;
    /** 일사는 있는데 인버터 출력 데이터가 없어 기대·실제에서 모두 뺀 인버터·시간 수 */
    readonly no_data_inverter_hours: number;
    readonly reason: string | null;
  };
}

export type PrReferenceMethod = 'params' | 'reference_clear_days';

export interface PrReference {
  readonly value: number;
  readonly method: PrReferenceMethod;
}

export interface SiteEnergyDay {
  /** KST 'YYYY-MM-DD' */
  readonly day: string;
  readonly flows_kwh: readonly EnergyFlow[];
  readonly energy_kwh: EnergyTotals;
  readonly h2_kg: H2Ledger;
  /** 전해조에 할당된 계통 수전 kWh / 전해조 kWh */
  readonly elz_grid_share: number | null;
  /** 전해조 입력 중 (PV + ESS 방전) 비율. ESS 방전은 PV로 충전했다고 가정한다 */
  readonly renewable_share: number | null;
  readonly elz_sec_kwh_per_kg: number | null;
  readonly fc_kg_per_mwh: number | null;
  readonly p2p_efficiency: number | null;
  readonly pv_loss_kwh: PvLossBreakdown | null;
  readonly dq: SiteEnergyDq;
  readonly alloc_version: typeof ALLOC_VERSION;
  readonly calc_version: string;
}
