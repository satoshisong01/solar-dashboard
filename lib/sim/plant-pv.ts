// 플랜트 조립: 태양광 인버터·MPPT, 기상관측, 계통 계량기.
// 오염 두 층: 가벼운 먼지(기본 누적, 비가 오면 씻김)와 끈적한 오염층(P3 고장, 강한 비·세척에서만 씻김).
// 방열판 온도 = 외기 + 5 + 30 × 부하율 × (1 + 냉각 성능 저하). 70 °C를 넘으면 90 °C에서 0이 되도록 출력을 선형으로 줄인다(온도 저감).
// 건강한 인버터는 평년 기상에서 방열판 최고 약 63 °C라 저감이 일어나지 않는다(1년·시드 2개 실측).
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
const STICKY_SOILING_MAX = 0.5;
const HEATSINK_OFFSET_C = 5;
const HEATSINK_RISE_C = 30;
/** 온도 저감 시작 방열판 온도 [°C] (제조사 70~85 °C 범위의 하단, 추정) */
const DERATE_START_C = 70;
/** 저감 시작부터 출력 0까지의 온도 폭 [°C] */
const DERATE_SPAN_C = 20;
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
  /** 끈적한 오염층 손실 비율 */
  readonly stickySoiling: number;
  /** 이번 스텝 방열판 온도 상승 계수 [°C/부하율] */
  readonly heatsinkRiseC: number;
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
      stickySoiling: 0,
      heatsinkRiseC: HEATSINK_RISE_C,
      trippedUntilMs: null,
      op: simulateInverter(rating, { poa: 0, ambientC: 20, soiling: 0, efficiencyDrop: 0, limitPct: 100, tripped: false }),
    };
  });
}

/** 두 오염층을 곱으로 합친 손실 비율 (끈적한 층이 없으면 가벼운 층 값을 그대로 쓴다) */
const combinedSoiling = (light: number, sticky: number): number => (sticky > 0 ? 1 - (1 - light) * (1 - sticky) : light);

/** 방열판이 저감 시작 온도를 넘는 부하면, 방열판 온도와 저감 곡선이 만나는 평형 부하율로 출력 제한 [%] */
function thermalLimitPct(ambientC: number, riseC: number, loadFraction: number): number {
  const base = ambientC + HEATSINK_OFFSET_C;
  if (base + riseC * loadFraction <= DERATE_START_C) return 100;
  const load = (1 - (base - DERATE_START_C) / DERATE_SPAN_C) / (1 + riseC / DERATE_SPAN_C);
  return 100 * clamp(load, 0, 1);
}

function stepInverter(unit: InverterUnit, ctx: StepContext, rng: Rng, events: SimEvent[]): InverterUnit {
  const tripDraw = rng.next(); // 상태와 무관하게 항상 뽑아 난수열을 고정한다
  const durationDraw = rng.next();
  const { weather, degradation, tMs, dtS } = ctx;
  const recovered = unit.trippedUntilMs !== null && tMs >= unit.trippedUntilMs;
  if (recovered) events.push(operationEvent(unit.code, tMs, EVENT_CODE.INVERTER_RESTART, 'info', '인버터 재기동'));
  const stillTripped = unit.trippedUntilMs !== null && !recovered;

  const cleaned = ctx.p3.pvCleaning;
  const soilingRate = degradation.value('pv.soilingPerDay', unit.code, tMs);
  const soiling = weather.raining || cleaned ? 0 : Math.min(SOILING_MAX, unit.soiling + (soilingRate * dtS) / SECONDS_PER_DAY);
  const stickyRate = degradation.value('pv.stickySoilingPerDay', unit.code, tMs);
  const stickySoiling = weather.heavyRain || cleaned ? 0 : Math.min(STICKY_SOILING_MAX, unit.stickySoiling + (stickyRate * dtS) / SECONDS_PER_DAY);
  const heatsinkRiseC = HEATSINK_RISE_C * (1 + degradation.value('inverter.coolingLoss', unit.code, tMs));
  const conditions: InverterConditions = {
    poa: weather.poa,
    ambientC: weather.ambientC,
    soiling: combinedSoiling(soiling, stickySoiling),
    efficiencyDrop: degradation.value('inverter.efficiencyDrop', unit.code, tMs),
    limitPct: ctx.pvLimitPct,
    tripped: stillTripped,
  };
  const normal = simulateInverter(unit.rating, conditions);
  const tripProbability = (TRIPS_PER_INVERTER_YEAR * dtS) / DAYLIGHT_SECONDS_PER_YEAR;
  const tripsNow = !stillTripped && normal.mode === 'running' && tripDraw < tripProbability;
  if (tripsNow) events.push(operationEvent(unit.code, tMs, EVENT_CODE.INVERTER_TRIP, 'major', '계통 이상 감지로 인버터 트립'));

  const limitPct = thermalLimitPct(weather.ambientC, heatsinkRiseC, normal.acKw / unit.rating.acKw);
  const running = limitPct < conditions.limitPct ? simulateInverter(unit.rating, { ...conditions, limitPct }) : normal;
  const op = tripsNow ? simulateInverter(unit.rating, { ...conditions, tripped: true }) : running;
  const trippedUntilMs = tripsNow ? tMs + (20 + 20 * durationDraw) * MS_PER_MINUTE : stillTripped ? unit.trippedUntilMs : null;
  return { ...unit, soiling, stickySoiling, heatsinkRiseC, trippedUntilMs, op, energyKwh: unit.energyKwh + (op.acKw * dtS) / SECONDS_PER_HOUR };
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
        'heatsink.temp': weather.ambientC + HEATSINK_OFFSET_C + unit.heatsinkRiseC * load,
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
