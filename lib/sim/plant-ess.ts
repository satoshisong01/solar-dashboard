// 플랜트 조립: ESS(PCS 1 + 배터리 랙 N). PCS AC 지령(방전 +)을 랙 DC 전력으로 나눠 적분한다.
import type { EssView } from './ems';
import { OP_STATE } from './events';
import { SECONDS_PER_HOUR } from './math';
import { converterLossKw, type ConverterLossModel } from './models/common';
import { nominalRackVoltageV, rackParams, stepRack, type RackParams, type RackState, type RackStep } from './models/battery';
import { DEGRADATION_PARAMS } from './scenarios';
import { assetsOfClass, nameplateNumber, singleAsset, sumOf, type InitContext, type ReadingEntry, type StepContext } from './plant-types';

const PCS_LOSS: ConverterLossModel = { noLoad: 0.002, linear: 0.01, quadratic: 0.01 };
const INITIAL_SOC = 0.5;
const INITIAL_RACK_TEMP_C = 24;
/** 준공 후 누적 충전량 추정: 하루 정격 용량의 0.8배 충전 */
const DAILY_CHARGE_CYCLES = 0.8;

export interface RackUnit {
  readonly code: string;
  readonly params: RackParams;
  readonly state: RackState;
  readonly last: RackStep;
}

export interface EssUnit {
  readonly plantCode: string;
  readonly pcsCode: string;
  readonly ratedKw: number;
  readonly racks: readonly RackUnit[];
  readonly chargeKwh: number;
  readonly dischargeKwh: number;
  /** PCS AC [kW], 방전 + */
  readonly acKw: number;
  /** 랙 DC 합 [kW], 충전 + */
  readonly dcKw: number;
}

export interface RoomClimate {
  readonly tempC: number;
  readonly humidityPct: number;
}

/** 공조되는 배터리실: 외기 영향을 조금만 받는다. */
export const batteryRoom = (ambientC: number, humidityPct: number): RoomClimate => ({
  tempC: 23.5 + 0.08 * (ambientC - 15),
  humidityPct: 45 + 0.15 * (humidityPct - 60),
});

function idleStep(params: RackParams, state: RackState): RackStep {
  return stepRack(params, state, { powerKw: 0, roomTempC: state.tempC, capacityFadePerDay: 0, cellImbalance: 0, dtS: 0 });
}

export function createEss(init: InitContext): EssUnit | null {
  if (assetsOfClass(init.site, 'ess.plant').length === 0) return null;
  const plant = singleAsset(init.site, 'ess.plant');
  const pcs = singleAsset(init.site, 'ess.pcs');
  const energyKwh = nameplateNumber(plant, 'energy_kwh');
  const racks = assetsOfClass(init.site, 'ess.rack').map((asset): RackUnit => {
    const params = rackParams(nameplateNumber(asset, 'capacity_ah'), nameplateNumber(asset, 'cells_series'), nameplateNumber(asset, 'cells_parallel'));
    const fadePerDay = DEGRADATION_PARAMS['battery.capacityFadePerDay'].baseline; // 준공~시작 전 이력은 기본값으로 추정
    const state: RackState = {
      soc: INITIAL_SOC + 0.01 * init.rng.gaussian(),
      soh: Math.max(0.5, 1 - fadePerDay * init.daysInService),
      tempC: INITIAL_RACK_TEMP_C,
    };
    return { code: asset.code, params, state, last: idleStep(params, state) };
  });
  const chargeKwh = init.daysInService * DAILY_CHARGE_CYCLES * energyKwh;
  return { plantCode: plant.code, pcsCode: pcs.code, ratedKw: nameplateNumber(pcs, 'power_kw'), racks, chargeKwh, dischargeKwh: chargeKwh * 0.88, acKw: 0, dcKw: 0 };
}

export function essView(ess: EssUnit): EssView {
  const pcsFactor = 0.98;
  const limitKw = (pick: (step: RackStep) => number) =>
    sumOf(ess.racks.map((r) => (pick(r.last) * nominalRackVoltageV(r.params)) / 1000)) * pcsFactor;
  return {
    socFraction: sumOf(ess.racks.map((r) => r.state.soc)) / ess.racks.length,
    chargeLimitKw: limitKw((s) => s.chargeLimitA),
    dischargeLimitKw: limitKw((s) => s.dischargeLimitA),
    ratedKw: ess.ratedKw,
    usableEnergyKwh: sumOf(ess.racks.map((r) => (r.params.capacityAh * r.state.soh * nominalRackVoltageV(r.params)) / 1000)),
  };
}

/** 방전 AC 목표를 내기 위한 DC 출력 (dc = ac + loss(dc)) */
function dischargeDcKw(ratedKw: number, acKw: number): number {
  let dcKw = acKw;
  for (let i = 0; i < 4; i += 1) dcKw = acKw + converterLossKw(PCS_LOSS, ratedKw, dcKw);
  return dcKw;
}

export function stepEss(ess: EssUnit, commandAcKw: number, room: RoomClimate, ctx: StepContext): EssUnit {
  const acTarget = Math.max(-ess.ratedKw, Math.min(ess.ratedKw, commandAcKw));
  const dcTargetKw = acTarget < 0 ? -acTarget - converterLossKw(PCS_LOSS, ess.ratedKw, -acTarget) : -dischargeDcKw(ess.ratedKw, acTarget);
  const rackPowerKw = dcTargetKw / ess.racks.length; // 충전 +
  const racks = ess.racks.map((rack): RackUnit => {
    const step = stepRack(rack.params, rack.state, {
      powerKw: rackPowerKw,
      roomTempC: room.tempC,
      capacityFadePerDay: ctx.degradation.value('battery.capacityFadePerDay', rack.code, ctx.tMs),
      cellImbalance: ctx.degradation.value('battery.cellImbalance', rack.code, ctx.tMs),
      dtS: ctx.dtS,
    });
    return { ...rack, state: step.state, last: step };
  });
  const dcKw = sumOf(racks.map((r) => r.last.powerKw));
  const acKw = dcKw > 0 ? -(dcKw + converterLossKw(PCS_LOSS, ess.ratedKw, dcKw)) : -dcKw - converterLossKw(PCS_LOSS, ess.ratedKw, -dcKw);
  const dtH = ctx.dtS / SECONDS_PER_HOUR;
  return {
    ...ess,
    racks,
    dcKw,
    acKw,
    chargeKwh: ess.chargeKwh + Math.max(0, -acKw) * dtH,
    dischargeKwh: ess.dischargeKwh + Math.max(0, acKw) * dtH,
  };
}

export function essReadings(ess: EssUnit, room: RoomClimate): readonly ReadingEntry[] {
  const load = Math.abs(ess.acKw) / ess.ratedKw;
  const plant: ReadingEntry = [
    ess.plantCode,
    {
      'room.temp': room.tempC,
      'room.humidity': room.humidityPct,
      'batt.current.limit.charge': sumOf(ess.racks.map((r) => r.last.chargeLimitA)),
      'batt.current.limit.discharge': sumOf(ess.racks.map((r) => r.last.dischargeLimitA)),
      'insulation.resistance': 5_500,
    },
  ];
  const pcs: ReadingEntry = [
    ess.pcsCode,
    {
      'ac.power': ess.acKw,
      'dc.power': -ess.dcKw,
      'ac.energy.charge.total': ess.chargeKwh,
      'ac.energy.discharge.total': ess.dischargeKwh,
      'heatsink.temp': room.tempC + 4 + 25 * load,
      'op.state': Math.abs(ess.acKw) > 1 ? OP_STATE.RUNNING : OP_STATE.STANDBY,
    },
  ];
  const racks = ess.racks.map((rack): ReadingEntry => [
    rack.code,
    {
      'batt.current': rack.last.currentA,
      'batt.voltage': rack.last.voltageV,
      'batt.soc': rack.state.soc * 100,
      'batt.soh': rack.state.soh * 100,
      'cell.voltage.max': rack.last.cellVoltageMaxV,
      'cell.voltage.min': rack.last.cellVoltageMinV,
      'cell.voltage.avg': rack.last.cellVoltageAvgV,
      'cell.temp.max': rack.last.cellTempMaxC,
      'cell.temp.min': rack.last.cellTempMinC,
      'cell.temp.avg': rack.last.cellTempAvgC,
    },
  ]);
  return [plant, pcs, ...racks];
}
