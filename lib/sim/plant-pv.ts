// 플랜트 조립: 태양광 인버터·MPPT, 기상관측, 계통 계량기.
import type { SiteDef } from '@/db/seed/types';
import { EVENT_CODE, opStateCode, operationEvent, type SimEvent } from './events';
import { clamp, MS_PER_MINUTE, SECONDS_PER_DAY, SECONDS_PER_HOUR } from './math';
import { moduleTemperatureC, simulateInverter, type InverterConditions, type InverterOperatingPoint, type InverterRating } from './models/pv';
import { assetsOfClass, nameplateNumber, sumOf, type InitContext, type ReadingEntry, type StepContext } from './plant-types';
import type { Rng } from './rng';
import { DEGRADATION_PARAMS } from './scenarios';

const INVERTER_AC_VOLTAGE_V = 380;
const GRID_VOLTAGE_V = 22_900;
/** 인버터 1대가 1년에 트립하는 평균 횟수 (주간 운전 중에만) */
const TRIPS_PER_INVERTER_YEAR = 4;
const DAYLIGHT_SECONDS_PER_YEAR = 365 * 12 * SECONDS_PER_HOUR;
const SOILING_MAX = 0.15;
/** 준공 후 누적 발전량 추정용 일평균 발전시간 [kWh/kWp/일] */
const SPECIFIC_YIELD_KWH_PER_KWP_DAY = 3.4;

export interface InverterUnit {
  readonly code: string;
  readonly rating: InverterRating;
  readonly mpptCodes: readonly string[];
  /** MPPT 채널별 DC 분담 비율 (합 1, 채널 미스매치) */
  readonly mpptShares: readonly number[];
  readonly energyKwh: number;
  readonly soiling: number;
  readonly trippedUntilMs: number | null;
  readonly op: InverterOperatingPoint;
}

export interface InverterStepResult {
  readonly units: readonly InverterUnit[];
  readonly acKw: number;
  readonly events: readonly SimEvent[];
}

export interface MeterUnit {
  readonly code: string | null;
  readonly netKw: number;
  readonly exportKwh: number;
  readonly importKwh: number;
}

export function createInverters(init: InitContext): readonly InverterUnit[] {
  return assetsOfClass(init.site, 'pv.inverter').map((asset) => {
    const rating: InverterRating = { acKw: nameplateNumber(asset, 'ac_kw'), dcKwp: nameplateNumber(asset, 'dc_kwp') };
    const mpptCodes = init.site.assets.filter((a) => a.classKey === 'pv.mppt' && a.code.startsWith(`${asset.code}/`)).map((a) => a.code);
    const weights = mpptCodes.map(() => 1 + 0.01 * init.rng.gaussian());
    const total = sumOf(weights);
    const soilingRate = DEGRADATION_PARAMS['pv.soilingPerDay'].baseline;
    return {
      code: asset.code,
      rating,
      mpptCodes,
      mpptShares: weights.map((w) => w / total),
      energyKwh: init.daysInService * SPECIFIC_YIELD_KWH_PER_KWP_DAY * rating.dcKwp * (1 + 0.01 * init.rng.gaussian()),
      soiling: Math.min(SOILING_MAX, soilingRate * 5),
      trippedUntilMs: null,
      op: simulateInverter(rating, { poa: 0, ambientC: 20, soiling: 0, efficiencyDrop: 0, limitPct: 100, tripped: false }),
    };
  });
}

function stepInverter(unit: InverterUnit, ctx: StepContext, rng: Rng, events: SimEvent[]): InverterUnit {
  const tripDraw = rng.next(); // 상태와 무관하게 항상 뽑아 난수열을 고정한다
  const durationDraw = rng.next();
  const { weather, degradation, tMs, dtS } = ctx;
  const recovered = unit.trippedUntilMs !== null && tMs >= unit.trippedUntilMs;
  if (recovered) events.push(operationEvent(unit.code, tMs, EVENT_CODE.INVERTER_RESTART, 'info', '인버터 재기동'));
  const stillTripped = unit.trippedUntilMs !== null && !recovered;

  const soilingRate = degradation.value('pv.soilingPerDay', unit.code, tMs);
  const soiling = weather.raining ? 0 : Math.min(SOILING_MAX, unit.soiling + (soilingRate * dtS) / SECONDS_PER_DAY);
  const conditions: InverterConditions = {
    poa: weather.poa,
    ambientC: weather.ambientC,
    soiling,
    efficiencyDrop: degradation.value('inverter.efficiencyDrop', unit.code, tMs),
    limitPct: ctx.pvLimitPct,
    tripped: stillTripped,
  };
  const normal = simulateInverter(unit.rating, conditions);
  const tripProbability = (TRIPS_PER_INVERTER_YEAR * dtS) / DAYLIGHT_SECONDS_PER_YEAR;
  const tripsNow = !stillTripped && normal.mode === 'running' && tripDraw < tripProbability;
  if (tripsNow) events.push(operationEvent(unit.code, tMs, EVENT_CODE.INVERTER_TRIP, 'major', '계통 이상 감지로 인버터 트립'));

  const op = tripsNow ? simulateInverter(unit.rating, { ...conditions, tripped: true }) : normal;
  const trippedUntilMs = tripsNow ? tMs + (20 + 20 * durationDraw) * MS_PER_MINUTE : stillTripped ? unit.trippedUntilMs : null;
  return { ...unit, soiling, trippedUntilMs, op, energyKwh: unit.energyKwh + (op.acKw * dtS) / SECONDS_PER_HOUR };
}

export function stepInverters(units: readonly InverterUnit[], ctx: StepContext, rng: Rng): InverterStepResult {
  const events: SimEvent[] = [];
  const next = units.map((unit) => stepInverter(unit, ctx, rng, events));
  return { units: next, acKw: sumOf(next.map((u) => u.op.acKw)), events };
}

export function inverterReadings(units: readonly InverterUnit[], ctx: StepContext): readonly ReadingEntry[] {
  const { weather } = ctx;
  const humidityFactor = clamp((weather.humidityPct - 60) / 40, 0, 1);
  const insulationKohm = 3_500 * (1 - 0.6 * humidityFactor) * (weather.raining ? 0.6 : 1);
  const acVoltageV = INVERTER_AC_VOLTAGE_V * ctx.gridVoltageFactor;
  return units.flatMap((unit): ReadingEntry[] => {
    const { op } = unit;
    const load = op.acKw / unit.rating.acKw;
    const inverter: ReadingEntry = [
      unit.code,
      {
        'ac.power': op.acKw,
        'dc.power': op.dcKw,
        'ac.energy.total': unit.energyKwh,
        'ac.voltage': acVoltageV,
        'ac.current': (op.acKw * 1000) / (Math.sqrt(3) * acVoltageV),
        'ac.frequency': ctx.gridFrequencyHz,
        'heatsink.temp': weather.ambientC + 5 + 30 * load,
        'insulation.resistance': insulationKohm,
        'ac.power.limit': ctx.pvLimitPct,
        'op.state': opStateCode(op.mode),
        'dc.voltage': op.dcVoltageV,
        'dc.current': op.dcCurrentA,
      },
    ];
    const mppts = unit.mpptCodes.map((code, index): ReadingEntry => [
      code,
      { 'dc.voltage': op.dcVoltageV, 'dc.current': op.dcCurrentA * (unit.mpptShares[index] ?? 0) },
    ]);
    return [inverter, ...mppts];
  });
}

export function createMeter(site: SiteDef, daysInService: number): MeterUnit {
  const meter = assetsOfClass(site, 'grid.meter')[0];
  const dcKwp = sumOf(assetsOfClass(site, 'pv.inverter').map((a) => nameplateNumber(a, 'dc_kwp')));
  return {
    code: meter?.code ?? null,
    netKw: 0,
    exportKwh: daysInService * SPECIFIC_YIELD_KWH_PER_KWP_DAY * dcKwp * 0.85,
    importKwh: daysInService * 60,
  };
}

/** 계량기 순전력: 수출 +, 수전 − */
export function stepMeter(meter: MeterUnit, netKw: number, dtS: number): MeterUnit {
  const dtH = dtS / SECONDS_PER_HOUR;
  return {
    ...meter,
    netKw,
    exportKwh: meter.exportKwh + Math.max(0, netKw) * dtH,
    importKwh: meter.importKwh + Math.max(0, -netKw) * dtH,
  };
}

export function siteCommonReadings(site: SiteDef, meter: MeterUnit, ctx: StepContext): readonly ReadingEntry[] {
  const { weather } = ctx;
  const station = assetsOfClass(site, 'wx.station')[0];
  const nightCooling = weather.poa < 1 ? 1.5 : 0; // 야간 복사냉각
  const entries: ReadingEntry[] = [];
  if (station) {
    entries.push([
      station.code,
      {
        'poa.irradiance': weather.poa,
        'ghi.irradiance': weather.ghi,
        'module.temp': moduleTemperatureC(weather.poa, weather.ambientC) - nightCooling,
        'ambient.temp': weather.ambientC,
        'ambient.humidity': weather.humidityPct,
        'wind.speed': weather.windMs,
      },
    ]);
  }
  if (meter.code) {
    entries.push([
      meter.code,
      {
        'ac.power': meter.netKw,
        'ac.energy.export.total': meter.exportKwh,
        'ac.energy.import.total': meter.importKwh,
        'ac.voltage': GRID_VOLTAGE_V * ctx.gridVoltageFactor,
        'ac.frequency': ctx.gridFrequencyHz,
      },
    ]);
  }
  return entries;
}
