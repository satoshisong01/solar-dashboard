// 체인 원장 파라미터 기본값. 현장 사양·계량점 위치가 정해지면 detector_config처럼 값만 바꾼다.

export interface LedgerParams {
  // 에너지 풀
  /** 보조부하 추정 [kW]. null이면 공급 − 계측 수요 잔여를 보조부하로 본다 (보조부하 계량이 없는 사이트) */
  readonly siteAuxKw: number | null;
  /** 한 시간 기대 샘플 수를 알 수 없을 때(행이 하나도 없는 설비) 쓰는 포인트 주기 [s] */
  readonly fallbackPeriodS: number;
  /** 전해조 kWh가 이보다 작으면 계통·재생 비율을 내지 않는다 */
  readonly minElzKwh: number;

  // 수소
  /**
   * 애노드 퍼지 1회당 손실 [kg]. 기본 0 = 추정하지 않음(손실은 잔차에 남는다).
   * fc.h2.consumption 계량점이 퍼지 전(공급 측)이면 퍼지가 이미 소비량에 들어 있으므로 0으로 둬야 이중 차감이 없다.
   */
  readonly kgPerPurge: number;
  /**
   * 건조기 재생 손실률 (생산량 대비). 기본 0 = 추정하지 않음.
   * h2.flow.mass 계량점이 건조기 뒤(제품)면 재생 손실은 이미 빠져 있으므로 0으로 둔다.
   */
  readonly dryerLossFraction: number;
  /** 유량계가 없을 때 패러데이 추정에 쓰는 패러데이 효율. 1이면 상한 추정(크로스오버·기동 배출 무시) */
  readonly faradayEfficiency: number;
  /** residual_pct 분모 하한 [kg] (생산·소비가 거의 없는 날 비율 폭주 방지) */
  readonly residualFloorKg: number;
  /** SEC·kg/MWh·P2P를 계산할 최소 수소량 [kg]과 연료전지 발전량 [kWh] */
  readonly minKpiH2Kg: number;
  readonly minKpiFcKwh: number;

  // PV 미활용 분해
  /** 모듈 최대출력 온도계수 [1/°C] (PERC 데이터시트 범위 −0.0035 부근 추정. 모듈 사양으로 교체) */
  readonly gammaPerC: number;
  /** 일사 있음 판정 [W/m²] (episodes/pv.ts DEFAULT_PV_DAY_PARAMS.sunIrradiance와 같은 값) */
  readonly sunIrradiance: number;
  /** 출력 제한 판정: ac.power.limit이 이 값 미만 [%] (episodes/pv.ts와 같은 규칙) */
  readonly limitFullPct: number;
  /** 클리핑 판정: 시간 최대 AC ≥ 정격 × 이 비율 (episodes/pv.ts clippingFraction과 같은 값) */
  readonly clippingFraction: number;
  /** 온도 디레이팅 판정 방열판 온도 [°C] (제조사 디레이팅 시작 온도 70~85°C 범위의 하단, 추정) */
  readonly deratingHeatsinkC: number;
  /** 온도 디레이팅 판정: 같은 시간 동종 인버터 비발전량 중앙값보다 이 비율 이상 낮음 */
  readonly deratingPeerDrop: number;
  readonly minPeers: number;
  /** ESS 만충 판정 SOC [%] (EMS 충전 SOC 상한 설정값으로 바꿀 것) */
  readonly essFullSocPct: number;
  /** 기준 PR 추정: 기준 기간 일사량 상위 분위(이 값 이상) 날을 맑은 날로 본다 */
  readonly clearDayQuantile: number;
  readonly minClearDays: number;
}

export const LEDGER_DEFAULTS: LedgerParams = Object.freeze({
  siteAuxKw: null,
  fallbackPeriodS: 300,
  minElzKwh: 1,
  kgPerPurge: 0,
  dryerLossFraction: 0,
  faradayEfficiency: 1,
  residualFloorKg: 1,
  minKpiH2Kg: 1,
  minKpiFcKwh: 1,
  gammaPerC: -0.0035,
  sunIrradiance: 50,
  limitFullPct: 99.5,
  clippingFraction: 0.99,
  deratingHeatsinkC: 70,
  deratingPeerDrop: 0.05,
  minPeers: 3,
  essFullSocPct: 90,
  clearDayQuantile: 0.8,
  minClearDays: 3,
});

export const resolveLedgerParams = (overrides: Partial<LedgerParams> = {}): LedgerParams => ({ ...LEDGER_DEFAULTS, ...overrides });
