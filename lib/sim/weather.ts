// 합성 기상: 간이 천문식 태양고도 → Haurwitz 청천 일사 × 운량 AR(1), 계절·일변화 기온, 강우일.
// 하루(KST) 단위로 시드를 파생하므로 시작 시각이 달라도 같은 날의 날씨는 같다.
import {
  clamp,
  interpolate,
  kstDayIndex,
  kstDayOfYear,
  kstHourOfDay,
  lerp,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  KST_OFFSET_MS,
  type Table,
} from './math';
import { createRng, hashSeed } from './rng';

const DEG = Math.PI / 180;
const MINUTES_PER_DAY = 1_440;
export const DEFAULT_TILT_DEG = 30;

/** 월별 평균 운량(0~1). 한국 서·남해안 경향 근사: 장마(7월) 최대, 가을 최소 */
const MONTHLY_CLOUD = [0.52, 0.52, 0.55, 0.55, 0.55, 0.62, 0.78, 0.68, 0.58, 0.48, 0.55, 0.55] as const;
/** 월별 강우일 확률 (장마 7월 최대) */
const MONTHLY_RAIN_PROBABILITY = [0.15, 0.17, 0.25, 0.27, 0.28, 0.33, 0.55, 0.4, 0.3, 0.18, 0.22, 0.18] as const;
/** 남서해안(목포 부근, 위도 34.8°) 월평균 기온 평년값 근사 [°C] */
const MONTHLY_MEAN_TEMP_C = [1.9, 3.4, 7.4, 12.8, 17.9, 22, 25.8, 26.9, 22.8, 17.6, 11.3, 4.6] as const;
const REFERENCE_LAT_DEG = 34.8;
const DAYS_PER_MONTH = 365 / 12;
/** 월 중앙일 기준 보간표 (12월→1월이 이어지도록 양끝을 덧댄다) */
const MEAN_TEMP_TABLE: Table = [
  [-DAYS_PER_MONTH / 2, MONTHLY_MEAN_TEMP_C[11]],
  ...MONTHLY_MEAN_TEMP_C.map((temp, month): readonly [number, number] => [(month + 0.5) * DAYS_PER_MONTH, temp]),
  [365 + DAYS_PER_MONTH / 2, MONTHLY_MEAN_TEMP_C[0]],
];
/** 월별 평균 상대습도(%) */
const MONTHLY_HUMIDITY = [62, 62, 64, 66, 70, 78, 84, 80, 74, 68, 66, 64] as const;

const CLOUD_AR_PHI = 0.97; // 분 단위 자기상관 (시정수 약 33분)
const CLOUD_STATIONARY_SD = 0.2;
const WIND_AR_PHI = 0.95;
const WIND_STATIONARY_SD = 0.8;

export interface SiteLocation {
  readonly code: string;
  readonly lat: number;
  readonly lon: number;
}

export interface SolarPosition {
  readonly cosZenith: number;
  readonly declinationRad: number;
  readonly hourAngleRad: number;
}

export interface Irradiance {
  readonly ghi: number;
  readonly dni: number;
  readonly dhi: number;
}

export interface WeatherSample extends Irradiance {
  readonly poa: number;
  readonly cosZenith: number;
  readonly cloud: number;
  readonly raining: boolean;
  readonly ambientC: number;
  readonly humidityPct: number;
  readonly windMs: number;
}

export interface Weather {
  sample(tMs: number): WeatherSample;
}

/** 간이 천문식: 적위(Cooper), 균시차, 시간각 → 천정각 코사인 */
export function solarPosition(latDeg: number, lonDeg: number, tMs: number): SolarPosition {
  const date = new Date(tMs);
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((tMs - startOfYear) / MS_PER_DAY) + 1;
  const utcHours = (tMs - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / MS_PER_HOUR;
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  const equationOfTimeMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const declinationRad = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  const solarTimeH = utcHours + lonDeg / 15 + equationOfTimeMin / 60;
  const hourAngleRad = 15 * DEG * (solarTimeH - 12);
  const lat = latDeg * DEG;
  const cosZenith =
    Math.sin(lat) * Math.sin(declinationRad) + Math.cos(lat) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  return { cosZenith, declinationRad, hourAngleRad };
}

/** Haurwitz 청천 수평면 전일사량 [W/m²] */
export function haurwitzGhi(cosZenith: number): number {
  return cosZenith <= 0 ? 0 : 1098 * cosZenith * Math.exp(-0.057 / cosZenith);
}

/**
 * 운량 → 청천 대비 GHI 투과율. Kasten–Czeplak(1 − 0.75·c^3.4)는 분 단위 AR(1) 운량에서
 * 한국 연평균 발전시간(약 3.6 kWh/kWp/일)보다 크게 나와, 중간 운량에서 더 감쇠하는 2차식으로 보정했다.
 */
export const cloudTransmittance = (cloud: number): number => 1 - 0.85 * clamp(cloud, 0, 1) ** 2;

/** 운량에 따라 산란 비율을 늘려 GHI를 직달·산란으로 나눈다. */
export function splitIrradiance(ghi: number, cosZenith: number, cloud: number): Irradiance {
  if (ghi <= 0 || cosZenith <= 0) return { ghi: 0, dni: 0, dhi: 0 };
  if (cosZenith < 0.05) return { ghi, dni: 0, dhi: ghi }; // 일출·일몰 직후는 산란만
  const dhi = ghi * clamp(0.14 + 0.86 * cloud ** 2, 0, 1);
  return { ghi, dni: (ghi - dhi) / cosZenith, dhi };
}

/** 남향 경사면 일사(POA): 직달×cosθ + 등방 산란 + 지면 반사 (Duffie & Beckman) */
export function planeOfArray(
  irradiance: Irradiance,
  latDeg: number,
  position: SolarPosition,
  tiltDeg: number,
  albedo = 0.2,
): number {
  if (position.cosZenith <= 0) return 0;
  const tilt = tiltDeg * DEG;
  const lat = latDeg * DEG;
  const { declinationRad: decl, hourAngleRad: omega } = position;
  const cosIncidence =
    Math.sin(decl) * Math.sin(lat - tilt) + Math.cos(decl) * Math.cos(lat - tilt) * Math.cos(omega);
  const beam = irradiance.dni * Math.max(0, cosIncidence);
  const diffuse = (irradiance.dhi * (1 + Math.cos(tilt))) / 2;
  const ground = (irradiance.ghi * albedo * (1 - Math.cos(tilt))) / 2;
  return beam + diffuse + ground;
}

/** 운량 0일 때의 일사 (시험·청천 기준선용) */
export function clearSkyIrradiance(
  latDeg: number,
  lonDeg: number,
  tMs: number,
  tiltDeg = DEFAULT_TILT_DEG,
): Irradiance & { readonly poa: number; readonly cosZenith: number } {
  const position = solarPosition(latDeg, lonDeg, tMs);
  const irradiance = splitIrradiance(haurwitzGhi(position.cosZenith), position.cosZenith, 0);
  return { ...irradiance, poa: planeOfArray(irradiance, latDeg, position, tiltDeg), cosZenith: position.cosZenith };
}

/** 계절 평균기온: 월평년값을 날짜로 보간하고 위도로 보정한다. */
export function seasonalMeanTempC(latDeg: number, dayOfYear: number): number {
  // 위도 1°당 기온 차는 겨울에 크고(해양성 제주 온난) 여름에 작다: 1월 2.2 °C, 7월 0.2 °C
  const latitudeGradient = 1.2 + Math.cos((2 * Math.PI * (dayOfYear - 15)) / 365);
  return interpolate(MEAN_TEMP_TABLE, dayOfYear - 0.5) - latitudeGradient * (latDeg - REFERENCE_LAT_DEG);
}

interface DayProfile {
  readonly dayIndex: number;
  readonly month: number;
  readonly cloud: Float64Array;
  readonly wind: Float64Array;
  readonly cloudMean: number;
  readonly rainStartMin: number;
  readonly rainEndMin: number;
  readonly anomalyStartC: number;
  readonly anomalyEndC: number;
}

function arSeries(
  rng: ReturnType<typeof createRng>,
  mean: number,
  phi: number,
  stationarySd: number,
  bounds: readonly [number, number],
): Float64Array {
  const series = new Float64Array(MINUTES_PER_DAY);
  const innovationSd = stationarySd * Math.sqrt(1 - phi * phi);
  let value = clamp(mean + stationarySd * rng.gaussian(), bounds[0], bounds[1]);
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
    series[minute] = value;
    value = clamp(mean + phi * (value - mean) + innovationSd * rng.gaussian(), bounds[0], bounds[1]);
  }
  return series;
}

/** 일별 기온 편차: 해시 가우시안을 이웃 날과 1-2-1로 평활해 날짜 사이가 이어지게 한다. */
function temperatureAnomalyC(location: SiteLocation, seed: number, dayIndex: number): number {
  const g = (day: number) => createRng(hashSeed(seed, location.code, 'temp-anomaly', day)).gaussian();
  return (3 * (g(dayIndex - 1) + 2 * g(dayIndex) + g(dayIndex + 1))) / 4;
}

function buildDayProfile(location: SiteLocation, seed: number, dayIndex: number): DayProfile {
  const rng = createRng(hashSeed(seed, location.code, 'weather-day', dayIndex));
  const month = new Date(dayIndex * MS_PER_DAY).getUTCMonth(); // KST 날짜의 월
  const rainy = rng.chance(MONTHLY_RAIN_PROBABILITY[month] ?? 0.2);
  const rainStartMin = rainy ? Math.floor(rng.uniform(0, 1_200)) : -1;
  const rainEndMin = rainy ? rainStartMin + Math.floor(rng.uniform(60, 480)) : -1;
  const cloudMean = clamp((MONTHLY_CLOUD[month] ?? 0.5) + 0.28 * rng.gaussian() + (rainy ? 0.2 : 0), 0.02, 0.98);
  const windMean = 2.2 + 1.2 * Math.abs(rng.gaussian());
  return {
    dayIndex,
    month,
    cloud: arSeries(rng, cloudMean, CLOUD_AR_PHI, CLOUD_STATIONARY_SD, [0, 1]),
    wind: arSeries(rng, windMean, WIND_AR_PHI, WIND_STATIONARY_SD, [0, 30]),
    cloudMean,
    rainStartMin,
    rainEndMin,
    anomalyStartC: temperatureAnomalyC(location, seed, dayIndex),
    anomalyEndC: temperatureAnomalyC(location, seed, dayIndex + 1),
  };
}

export function createWeather(location: SiteLocation, seed: number, tiltDeg = DEFAULT_TILT_DEG): Weather {
  let cached: DayProfile | null = null;
  const profileFor = (dayIndex: number): DayProfile => {
    const profile = cached !== null && cached.dayIndex === dayIndex ? cached : buildDayProfile(location, seed, dayIndex);
    cached = profile;
    return profile;
  };

  return {
    sample(tMs: number): WeatherSample {
      const day = profileFor(kstDayIndex(tMs));
      const minute = Math.floor((tMs + KST_OFFSET_MS - day.dayIndex * MS_PER_DAY) / MS_PER_MINUTE);
      const raining = minute >= day.rainStartMin && minute < day.rainEndMin;
      const cloud = raining ? Math.max(day.cloud[minute] ?? 1, 0.92) : (day.cloud[minute] ?? day.cloudMean);

      const position = solarPosition(location.lat, location.lon, tMs);
      const ghi = haurwitzGhi(position.cosZenith) * cloudTransmittance(cloud);
      const irradiance = splitIrradiance(ghi, position.cosZenith, cloud);

      const hour = kstHourOfDay(tMs);
      const diurnal = 4.5 * (1 - 0.5 * day.cloudMean) * Math.cos((2 * Math.PI * (hour - 15)) / 24);
      const anomaly = lerp(day.anomalyStartC, day.anomalyEndC, hour / 24);
      const ambientC = seasonalMeanTempC(location.lat, kstDayOfYear(tMs)) + anomaly + diurnal - (raining ? 1.5 : 0);
      const baseHumidity = MONTHLY_HUMIDITY[day.month] ?? 70;
      const humidityPct = raining ? 97 : clamp(baseHumidity + 18 * (cloud - 0.5) - 2.5 * diurnal, 20, 100);

      return {
        ...irradiance,
        poa: planeOfArray(irradiance, location.lat, position, tiltDeg),
        cosZenith: position.cosZenith,
        cloud,
        raining,
        ambientC,
        humidityPct,
        windMs: day.wind[minute] ?? 2,
      };
    },
  };
}
