// 가평 구성 부속 계통: 부산물 산소 · 폐열회수 열교환기 · 수처리 · 수소 감압밸브 · 외부 수소 반입(하역).
// 근거: 도면 FCND-GP-PID-002 REV.2와 docs/renewal/research/pid/ (oxygen·heat·water·pressure·supply).
//
// 이 모듈이 재현하는 구조적 사실 (조사 결과 그대로)
//   산소: 생산 357 kg/h에 저장 30 m³·15 bar(만재 약 590 kg)뿐이라 체류가 1.8시간이고, 도면에 승압 압축기가 없어
//         튜브트레일러 충전이 불가능하다 → 만재 뒤 생산분은 계속 방출된다 (research-oxygen §0).
//   폐열: FC 냉각수 75 °C·350 kWth 중 수전해 급수 예열에 실제로 필요한 열은 0.5 m³/h × ΔT 40 K = 23.3 kW뿐이다.
//         나머지는 덤프 쿨러로 간다 → 1차측 온도강하가 1 K 수준이라 도면의 '환수 60 °C'는 이 유량으로 성립하지 않는다 (research-heat).
//   물:   급수 0.5 m³/h ÷ 생산 44.9 kg/h = 11.13 L/kg (화학양론 8.93 L/kg + 가스 반출·전처리 배출).
//   반입: 자급률 37%라 버퍼(55분)로는 못 버티고 하루 여러 대의 트레일러가 들어와야 한다 (research-supply §2.1).
import type { SiteDef } from '@/db/seed/types';
import { OP_STATE } from './events';
import { clamp, SECONDS_PER_HOUR } from './math';
import { assetsOfClass, nameplateNumber, singleAsset, type InitContext, type ReadingEntry, type StepContext } from './plant-types';

/** H₂O → H₂ + ½O₂: 산소 질량 / 수소 질량 = 31.998 / (2 × 2.016) */
export const O2_PER_H2_KG = 7.936;
/** 산소 기체상수 [J/(kg·K)] = 8314.46 / 31.998 */
const O2_GAS_CONSTANT = 259.84;
/** 물 비열 [kJ/(kg·K)] */
const CP_WATER = 4.186;
/** 도면 급수 0.5 m³/h ÷ 정격 생산 44.9 kg/h [L/kg] */
export const WATER_L_PER_KG_H2 = 11.13;
/** 도면 재순환 0.3 ÷ 급수 0.5 */
const RECYCLE_RATIO = 0.6;
/** Type I 튜브트레일러 잔압 70 bar 기준 실운송량 [kg] (research-supply §1.1) */
export const TRAILER_KG = 198;
const TRAILER_FULL_BAR = 200;
const TRAILER_HEEL_BAR = 70;
/** 하역 속도 [kg/h] — 시뮬레이터 가정 (국내 실측치 미확보, research-supply 미해결 9번) */
const UNLOAD_KG_H = 200;
/** 버퍼 압력이 최고 압력의 이 비율 아래로 내려가면 트레일러를 부른다 (시뮬레이터 가정) */
const CALL_TRUCK_FRACTION = 0.35;
/**
 * 하역을 멈추는 버퍼 압력 비율 (시뮬레이터 가정). 만재까지 채우면 자체 생산분을 받을 자리가 없어져
 * 수전해가 정지한다 — 현장 운전도 자체 생산을 우선하고 반입은 모자란 만큼만 받는다.
 */
const DELIVERY_TARGET_FRACTION = 0.5;
/** 하역 헤더 압력이 버퍼보다 이만큼 높아야 이송된다 [bar] */
const UNLOAD_MARGIN_BAR = 3;

export interface GapyeongCodes {
  readonly o2Plant: string;
  readonly o2Tank: string;
  readonly o2Load: string;
  readonly hx: string;
  readonly water: string;
  readonly waterTank: string;
  readonly prv: string;
  readonly delivery: string;
}

export interface GapyeongParams {
  /** 산소 저장탱크 내용적 [m³]·최고 압력 [bar] */
  readonly o2VolumeM3: number;
  readonly o2MaxBar: number;
  /** 승압 압축기 유무 (도면 기준 none이면 트레일러 충전 불가 → 전량 방출) */
  readonly o2CompressorPresent: boolean;
  /** 열교환기 설계 UA [kW/K]와 설계 열출력 [kWth] */
  readonly hxUaKwK: number;
  readonly hxDutyKw: number;
  /** DI 물탱크 내용적 [m³] */
  readonly waterTankM3: number;
  /** 설계 급수·재순환 [m³/h] */
  readonly feedM3H: number;
  /** 감압밸브 입구 최고·출구 설정 압력 [bar] */
  readonly prvInletMaxBar: number;
  readonly prvOutletSetBar: number;
}

export interface GapyeongState {
  /** 산소 저장 질량 [kg] */
  readonly o2MassKg: number;
  readonly o2ProducedTotalKg: number;
  readonly o2ShippedTotalKg: number;
  readonly o2VentedTotalKg: number;
  readonly o2Venting: boolean;
  /** 누적 회수 열량 [kWh] */
  readonly hxHeatTotalKwh: number;
  readonly hxColdOutC: number;
  /** 누적 급수량 [m³] */
  readonly waterVolumeTotalM3: number;
  readonly waterTankLevelPct: number;
  /** 순수 제조설비 운전 중 (물탱크 수위 히스테리시스) */
  readonly waterMakeupOn: boolean;
  /** 감압밸브 하류 압력 [bar] */
  readonly prvOutletBar: number;
  /** 하역 계량 적산 [kg] (계량기 이득 반영 — 기록 누락 고장이면 늘지 않는다) */
  readonly deliveryMeterKg: number;
  /** 하역으로 실제 들어온 양 [kg] (참값) */
  readonly deliveredTrueKg: number;
  /** 지금 하역 중인 트레일러가 남긴 양 [kg]. 0이면 하역 중이 아니다 */
  readonly trailerRemainingKg: number;
  readonly deliveryCount: number;
  readonly ventTotalKg: number;
}

export interface GapyeongUnit {
  readonly codes: GapyeongCodes;
  readonly params: GapyeongParams;
  readonly state: GapyeongState;
  /** 직전 스텝 하역 유량 [kg/h] */
  readonly deliveryKgH: number;
  /** 직전 스텝 회수 열출력 [kW] */
  readonly hxHeatKw: number;
}

/** 이 사이트에 가평 구성 부속 계통이 있는지 (산소·열교환·감압·반입·물탱크가 모두 있어야 한다) */
export const hasGapyeongSubsystems = (site: SiteDef): boolean =>
  ['o2.plant', 'o2.storage.tank', 'o2.loading', 'hx.recovery', 'h2.prv', 'h2.delivery', 'h2.elz.water.tank'].every((classKey) => assetsOfClass(site, classKey).length === 1);

/** 산소 이상기체 질량 [kg] (15 bar에서 Z 보정은 약 1% — research-oxygen) */
const o2MassAt = (bar: number, volumeM3: number, tempC: number): number => (bar * 1e5 * volumeM3) / (O2_GAS_CONSTANT * (tempC + 273.15));
const o2PressureAt = (massKg: number, volumeM3: number, tempC: number): number => (massKg * O2_GAS_CONSTANT * (tempC + 273.15)) / volumeM3 / 1e5;

function resolveParams(site: SiteDef): GapyeongParams {
  const tank = singleAsset(site, 'o2.storage.tank');
  const load = singleAsset(site, 'o2.loading');
  const hx = singleAsset(site, 'hx.recovery');
  const water = singleAsset(site, 'h2.elz.water');
  const prv = singleAsset(site, 'h2.prv');
  return {
    o2VolumeM3: nameplateNumber(tank, 'water_volume_m3'),
    o2MaxBar: nameplateNumber(tank, 'max_bar'),
    o2CompressorPresent: load.nameplate.compressor_present === 'installed',
    hxUaKwK: nameplateNumber(hx, 'design_ua_kw_k'),
    hxDutyKw: nameplateNumber(hx, 'duty_kw'),
    waterTankM3: nameplateNumber(singleAsset(site, 'h2.elz.water.tank'), 'volume_m3'),
    feedM3H: nameplateNumber(water, 'feed_m3_h'),
    prvInletMaxBar: nameplateNumber(prv, 'inlet_bar_max'),
    prvOutletSetBar: nameplateNumber(prv, 'outlet_bar_set'),
  };
}

function resolveCodes(site: SiteDef): GapyeongCodes {
  const code = (classKey: string) => singleAsset(site, classKey).code;
  return {
    o2Plant: code('o2.plant'),
    o2Tank: code('o2.storage.tank'),
    o2Load: code('o2.loading'),
    hx: code('hx.recovery'),
    water: code('h2.elz.water'),
    waterTank: code('h2.elz.water.tank'),
    prv: code('h2.prv'),
    delivery: code('h2.delivery'),
  };
}

export function createGapyeong(init: InitContext): GapyeongUnit | null {
  if (!hasGapyeongSubsystems(init.site)) return null;
  const params = resolveParams(init.site);
  const days = init.daysInService;
  return {
    codes: resolveCodes(init.site),
    params,
    // 준공 후 누적값은 추정치다 (하루 수전해 5시간 가정 — plant-hydrogen ELZ_HOURS_PER_DAY와 같은 가정)
    state: {
      o2MassKg: o2MassAt(params.o2MaxBar * 0.6, params.o2VolumeM3, 20),
      o2ProducedTotalKg: days * 5 * 357,
      o2ShippedTotalKg: 0,
      o2VentedTotalKg: days * 5 * 357,
      o2Venting: false,
      hxHeatTotalKwh: days * 4 * 23,
      hxColdOutC: 20,
      waterVolumeTotalM3: days * 5 * params.feedM3H,
      waterTankLevelPct: 70,
      waterMakeupOn: true,
      prvOutletBar: params.prvOutletSetBar,
      deliveryMeterKg: days * 800,
      deliveredTrueKg: days * 800,
      trailerRemainingKg: 0,
      deliveryCount: Math.round(days * 4),
      ventTotalKg: 0,
    },
    deliveryKgH: 0,
    hxHeatKw: 0,
  };
}

export interface GapyeongInput {
  /** 전해조 제품 수소 생산 [kg/h] */
  readonly h2ProductKgH: number;
  /** 전해조 부하율 0~1 (정지면 0) */
  readonly elzLoad: number;
  readonly elzRunning: boolean;
  /** 연료전지 수소 소비 [kg/h] */
  readonly fcH2KgH: number;
  /** 연료전지 냉각수 출구 온도 [°C] (열교환기 1차측 입구) */
  readonly coolantOutC: number;
  readonly fcRunning: boolean;
  /** 수소 버퍼 압력 [bar] */
  readonly bufferBar: number;
}

/**
 * 하역 유량 [kg/h]: 버퍼가 호출 압력 아래로 내려가면 트레일러 한 대가 와서 남은 양을 다 내린다.
 * 버퍼가 하역 헤더 압력에 가까워지면(잔압 하한) 더 못 넣는다 — 수입 뱅크·압축기가 없는 구성의 한계다.
 */
export function deliveryRateKgH(unit: GapyeongUnit, input: GapyeongInput, maxBufferBar: number): number {
  const trailerBar = trailerPressureBar(unit.state.trailerRemainingKg);
  const unloading = unit.state.trailerRemainingKg > 0;
  const calling = input.bufferBar < maxBufferBar * CALL_TRUCK_FRACTION;
  if (!unloading && !calling) return 0;
  if (input.bufferBar >= maxBufferBar * DELIVERY_TARGET_FRACTION) return 0; // 자체 생산분 자리를 남긴다
  if (trailerBar <= input.bufferBar + UNLOAD_MARGIN_BAR) return 0;
  return UNLOAD_KG_H;
}

/** 물탱크 보충 히스테리시스: 85% 아래면 켜고 90%에서 끈다 (20 m³ 탱크가 완충 역할을 한다) */
const MAKEUP_ON_PCT = 85;
const MAKEUP_OFF_PCT = 90;

/** 순수 제조설비 운전 여부 (물탱크 수위 히스테리시스). 수전해 운전과 무관하게 탱크를 채운다 */
export const waterMakeupOn = (levelPct: number, was: boolean): boolean => (was ? levelPct < MAKEUP_OFF_PCT : levelPct < MAKEUP_ON_PCT);

/** 정제수 급수 유량 [m³/h] (물탱크 보충 = 누적 급수 적산의 분자): 제조설비가 돌면 설계 급수량, 아니면 0 */
export const feedFlowM3H = (params: GapyeongParams, makeupOn: boolean): number => (makeupOn ? params.feedM3H : 0);

/**
 * 열교환기 2차측 유량 [m³/h] [가정]: 물탱크 보충 중이거나 연료전지가 돌 때 설계 급수량만큼 흐른다.
 * 연료전지 운전 시간과 수전해 급수 시간이 어긋나므로, 폐열을 DI 탱크에 저장하는 순환 운전을 가정했다
 * (도면의 recycle_source가 미확인이라 실제 구성이 확정되면 바꿔야 한다).
 */
export const hxColdFlowM3H = (params: GapyeongParams, makeupOn: boolean, fcRunning: boolean): number => (makeupOn || fcRunning ? params.feedM3H : 0);

/** 트레일러 잔압 [bar]: 만재 200 bar → 잔압 70 bar 사이를 남은 양에 비례해 간다 */
export const trailerPressureBar = (remainingKg: number): number =>
  remainingKg <= 0 ? TRAILER_HEEL_BAR : TRAILER_HEEL_BAR + ((TRAILER_FULL_BAR - TRAILER_HEEL_BAR) * clamp(remainingKg / TRAILER_KG, 0, 1));

/** 열교환기: ε-NTU 향류. 냉측(수전해 급수)이 Cmin이라 Cr ≈ 0으로 본다 */
export function hxOutlets(params: GapyeongParams, hotInC: number, coldInC: number, coldM3H: number, fouling: number): { readonly coldOutC: number; readonly hotOutC: number; readonly heatKw: number } {
  const cCold = ((coldM3H * 1000) / SECONDS_PER_HOUR) * CP_WATER; // [kW/K]
  if (cCold <= 0 || hotInC <= coldInC) return { coldOutC: coldInC, hotOutC: hotInC, heatKw: 0 };
  const ua = Math.max(0, params.hxUaKwK * (1 - clamp(fouling, 0, 0.95)));
  const effectiveness = 1 - Math.exp(-ua / cCold);
  const coldOutC = coldInC + effectiveness * (hotInC - coldInC);
  const heatKw = cCold * (coldOutC - coldInC);
  // 1차측은 FC 냉각 루프 전체 열량(설계 duty)을 싣고 지나간다 → 회수한 만큼만 온도가 내려간다
  const cHot = params.hxDutyKw / 15; // 설계 1차측 ΔT 15 K (도면 75 → 60 °C)로 잡은 열용량류 [kW/K]
  return { coldOutC, hotOutC: hotInC - heatKw / Math.max(cHot, 1e-6), heatKw };
}

export interface GapyeongStepResult {
  readonly unit: GapyeongUnit;
  /** 이번 스텝에 버퍼로 넣은 반입량 [kg/h] (plant-hydrogen이 저장부에 그대로 전달한다) */
  readonly deliveryKgH: number;
}

export function stepGapyeong(unit: GapyeongUnit, input: GapyeongInput, ctx: StepContext, deliveredKg: number): GapyeongUnit {
  const { params, codes, state } = unit;
  const dtH = ctx.dtS / SECONDS_PER_HOUR;
  const deg = ctx.degradation;
  const ambientC = ctx.weather.ambientC;

  // ── 산소: 생산 → 저장 → (압축기가 있으면 출하) → 만재분 방출
  const o2ProducedKg = input.h2ProductKgH * O2_PER_H2_KG * dtH;
  const o2TempC = ambientC + 2;
  const capacityKg = o2MassAt(params.o2MaxBar, params.o2VolumeM3, o2TempC);
  const shippedKg = params.o2CompressorPresent ? Math.min(Math.max(0, state.o2MassKg - capacityKg * 0.2), 300 * dtH) : 0;
  const afterShip = state.o2MassKg - shippedKg + o2ProducedKg;
  const ventedKg = Math.max(0, afterShip - capacityKg);
  const o2MassKg = afterShip - ventedKg;

  // ── 폐열회수: FC가 돌 때만 1차측에 열이 실린다. 2차측은 순수 제조설비 급수(물탱크 보충)
  const makeupOn = waterMakeupOn(state.waterTankLevelPct, state.waterMakeupOn);
  const feedM3H = feedFlowM3H(params, makeupOn);
  const coldInC = clamp(ambientC, 5, 35);
  const hotInC = input.fcRunning ? input.coolantOutC : ambientC + 2;
  const hx = input.fcRunning
    ? hxOutlets(params, hotInC, coldInC, hxColdFlowM3H(params, makeupOn, input.fcRunning), deg.value('hx.fouling', codes.hx, ctx.tMs))
    : { coldOutC: coldInC, hotOutC: hotInC, heatKw: 0 };

  // ── 수처리: 급수 적산·재순환·물탱크 수위
  const feedM3 = feedM3H * dtH;
  const waterVolumeTotalM3 = state.waterVolumeTotalM3 + feedM3;
  const consumedM3 = (input.h2ProductKgH * WATER_L_PER_KG_H2 * dtH) / 1000;
  const waterTankLevelPct = clamp(state.waterTankLevelPct + ((feedM3 - consumedM3) / params.waterTankM3) * 100, 5, 100);

  // ── 감압밸브: 유동이 있으면 설정압 부근, 무유동이면 락업(설정압 + SG 여유) + 시트 누설에 따른 크리프
  const flowing = input.fcH2KgH > 0.05;
  const lockupBar = params.prvOutletSetBar * 1.1; // EN 334 SG 10 등급 가정 (명판 미확인)
  const supplyEffect = 0.02 * Math.max(0, input.bufferBar - params.prvInletMaxBar * 0.5); // 공급압이 높을수록 락업압이 조금 올라간다
  const creepBar = deg.value('prv.seatLeakBarPerH', codes.prv, ctx.tMs) * dtH;
  const prvOutletBar = flowing
    ? params.prvOutletSetBar - 0.05 * clamp(input.fcH2KgH / 120, 0, 1)
    : Math.min(params.prvInletMaxBar, Math.max(state.prvOutletBar, lockupBar + supplyEffect) + creepBar);

  // ── 외부 반입: 트레일러 한 대를 다 내리면 다음 호출까지 쉰다. 계량기 이득 0 = 반입 기록 누락 고장
  const meterGain = deg.value('delivery.meterGain', codes.delivery, ctx.tMs);
  const trailerRemainingKg = state.trailerRemainingKg > 0 ? Math.max(0, state.trailerRemainingKg - deliveredKg) : deliveredKg > 0 ? Math.max(0, TRAILER_KG - deliveredKg) : 0;
  const startedTruck = state.trailerRemainingKg <= 0 && deliveredKg > 0;

  return {
    ...unit,
    state: {
      o2MassKg,
      o2ProducedTotalKg: state.o2ProducedTotalKg + o2ProducedKg,
      o2ShippedTotalKg: state.o2ShippedTotalKg + shippedKg,
      o2VentedTotalKg: state.o2VentedTotalKg + ventedKg,
      o2Venting: ventedKg > 0,
      hxHeatTotalKwh: state.hxHeatTotalKwh + hx.heatKw * dtH,
      hxColdOutC: hx.coldOutC,
      waterVolumeTotalM3,
      waterTankLevelPct,
      waterMakeupOn: makeupOn,
      prvOutletBar,
      deliveryMeterKg: state.deliveryMeterKg + deliveredKg * meterGain,
      deliveredTrueKg: state.deliveredTrueKg + deliveredKg,
      trailerRemainingKg,
      deliveryCount: state.deliveryCount + (startedTruck ? 1 : 0),
      ventTotalKg: state.ventTotalKg,
    },
    deliveryKgH: deliveredKg / Math.max(dtH, 1e-9),
    hxHeatKw: hx.heatKw,
  };
}

/** 하역 상태 코드: 0 대기 · 3 하역중 (op.state 코드 규약을 따른다) */
const deliveryStateCode = (unloading: boolean): number => (unloading ? OP_STATE.RUNNING : OP_STATE.STANDBY);

export function gapyeongReadings(unit: GapyeongUnit, input: GapyeongInput, ctx: StepContext): readonly ReadingEntry[] {
  const { codes, params, state } = unit;
  const deg = ctx.degradation;
  const ambientC = ctx.weather.ambientC;
  const o2TempC = ambientC + 2;
  const o2Bar = o2PressureAt(state.o2MassKg, params.o2VolumeM3, o2TempC);
  const unloading = unit.deliveryKgH > 0;
  const feedM3H = feedFlowM3H(params, state.waterMakeupOn);
  const coldFlowM3H = hxColdFlowM3H(params, state.waterMakeupOn, input.fcRunning);
  const coldInC = clamp(ambientC, 5, 35);
  // 애노드 원가스 HTO [vol%]: 부분부하에서 크로스오버 비중이 커진다. 법정 압축금지선은 2%다 (research-oxygen)
  const htoPct = input.elzRunning ? (0.35 + 0.25 / Math.max(input.elzLoad, 0.15)) * 0.6 + deg.value('o2.htoRise', codes.o2Plant, ctx.tMs) : 0;
  const conductivityRise = deg.value('water.conductivityRise', codes.water, ctx.tMs);
  return [
    [codes.o2Plant, {
      'o2.flow.mass#production': input.h2ProductKgH * O2_PER_H2_KG,
      'o2.purity': input.elzRunning ? 99.6 - Math.min(0.6, htoPct * 0.2) : 99.5,
      'o2.dewpoint': input.elzRunning ? -45 : -30,
      'o2.detector.pct#vent': 20.9 + (state.o2Venting ? 2.4 : 0),
      'h2.in.o2#o2.product': htoPct,
    }],
    [codes.o2Tank, {
      'tank.pressure#o2': o2Bar,
      'tank.temp#o2': o2TempC,
      'valve.open#o2.vent': state.o2Venting ? 1 : 0,
      'o2.detector.pct#tankroom': 20.9,
    }],
    [codes.o2Load, {
      'o2.shipped.mass.total': state.o2ShippedTotalKg,
      'o2.loading.pressure': params.o2CompressorPresent ? 150 : Math.max(0, o2Bar - 0.5),
      'o2.flow.mass#loading': 0,
      'valve.open#o2.loading': 0,
      'o2.detector.pct#loading': 20.9,
    }],
    [codes.hx, {
      'hx.temp.hot.in': input.fcRunning ? input.coolantOutC : ambientC + 2,
      'hx.temp.hot.out': input.fcRunning ? input.coolantOutC - unit.hxHeatKw / Math.max(params.hxDutyKw / 15, 1e-6) : ambientC + 2,
      'hx.temp.cold.in': coldInC,
      'hx.temp.cold.out': state.hxColdOutC,
      'hx.flow.hot': input.fcRunning ? params.hxDutyKw / 15 / ((1000 / SECONDS_PER_HOUR) * CP_WATER) : 0,
      'hx.heat.recovered': unit.hxHeatKw,
      'hx.heat.total': state.hxHeatTotalKwh,
      'hx.pressure.diff.hot': input.fcRunning ? 45 : 0,
      'hx.pressure.diff.cold': coldFlowM3H > 0 ? 30 : 0,
      // 교차누설 감시: 2차측(수전해 급수) 전도도가 1차측보다 높아지면 누설이다
      'water.conductivity#feed.in': 0.06,
      'water.conductivity#feed': 0.06 + conductivityRise,
    }],
    [codes.water, {
      'water.flow.feed': feedM3H,
      'water.flow.recycle': feedM3H * RECYCLE_RATIO,
      'water.volume.total': state.waterVolumeTotalM3,
      'water.conductivity#ro': 4.5 + 6 * conductivityRise,
      'ro.flow.permeate': feedM3H * 1.2,
      'ro.flow.reject': feedM3H * 0.4,
      'ro.pressure.feed': feedM3H > 0 ? 12 + 2 * conductivityRise : 0,
      'ro.pressure.diff': feedM3H > 0 ? 0.8 + 0.4 * conductivityRise : 0,
    }],
    [codes.waterTank, {
      'water.tank.level': state.waterTankLevelPct,
      'water.level.alarm#low': state.waterTankLevelPct < 20 ? 1 : 0,
      'water.level.alarm#high': state.waterTankLevelPct > 92 ? 1 : 0,
    }],
    [codes.prv, {
      'h2.pressure#fc.inlet': state.prvOutletBar,
      'h2.pressure.setpoint': params.prvOutletSetBar,
      'h2.pressure.ripple': input.fcH2KgH > 0.05 ? 0.02 : 0.004,
      'filter.pressure.diff#prv': input.fcH2KgH > 0.05 ? 0.15 : 0.01,
      'vent.temp': ambientC + 1,
    }],
    [codes.delivery, {
      'h2.delivery.mass.total': state.deliveryMeterKg,
      'h2.delivery.flow.mass': unloading ? unit.deliveryKgH * deg.value('delivery.meterGain', codes.delivery, ctx.tMs) : 0,
      'h2.delivery.pressure': unloading ? trailerPressureBar(state.trailerRemainingKg) - 2 : 0.5,
      'h2.delivery.temp': ambientC - (unloading ? 6 : 0),
      'h2.delivery.state': deliveryStateCode(unloading),
      'h2.delivery.ground': unloading ? 1 : 0,
      'h2.trailer.pressure': state.trailerRemainingKg > 0 ? trailerPressureBar(state.trailerRemainingKg) : TRAILER_HEEL_BAR,
      'h2.vent.mass.total': state.ventTotalKg,
    }],
  ];
}

