// 사이트 플랜트: 상태를 시간 스텝(기본 60초)으로 전진시키고, 포인트별 period_s에 맞춰 센서값을 샘플링한다.
import { METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import type { MetricDef, PointDef, SiteDef } from '@/db/seed/types';
import { controlsAt, weatherWindowsOf, type StepControls } from './control-scenarios';
import { p3ControlsAt, p3WeatherWindows } from './control-scenarios-p3';
import { dispatch, INITIAL_EMS_MEMORY, type EmsMemory, type HydrogenView, type SiteLayout } from './ems';
import { EVENT_CODE, safetyAlarm, type SimEvent } from './events';
import { kstDateToMs, kstHourOfDay, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND, SECONDS_PER_DAY } from './math';
import { batteryRoom, createEss, essReadings, essView, stepEss, type EssUnit, type RoomClimate } from './plant-ess';
import { createHydrogen, hydrogenReadings, hydrogenView, stepHydrogen, type HydrogenUnit } from './plant-hydrogen';
import { createInverters, createMeter, inverterReadings, siteCommonReadings, stepInverters, stepMeter, type InverterUnit, type MeterUnit } from './plant-pv';
import { assetsOfClass, readingKey, type AssetReadings, type StepContext } from './plant-types';
import { deriveRng, type Rng } from './rng';
import { createDegradationResolver, EMPTY_PLAN, type SiteScenarioPlan } from './scenarios';
import { addNoise, formatRaw, spikeValue } from './sensors';
import { createWeather } from './weather';

/** 안전 경보 후 수소 설비 인터록 유지 시간 */
export const SAFETY_LOCKOUT_MS = 2 * MS_PER_HOUR;
const AUX_KW: Readonly<Record<SiteLayout, number>> = { pv_ess: 8, integrated: 20 };

export interface PlantSample {
  readonly sourceKey: string;
  readonly unit: string;
  readonly periodS: number;
  /** 참 시각 (게이트웨이 시계 오차 적용 전) */
  readonly ts: number;
  /** 원본 단위 값 */
  readonly value: number;
  readonly mapped: boolean;
}

export interface PlantStep {
  readonly tMs: number;
  readonly samples: readonly PlantSample[];
  readonly events: readonly SimEvent[];
  /** 노이즈 전 정규 단위 참값 (설비 코드 → 메트릭 키) — 정답 기록·검증용 */
  readonly readings: ReadonlyMap<string, AssetReadings>;
}

export interface Plant {
  readonly site: SiteDef;
  readonly stepS: number;
  /** 직전 스텝 + stepS 시각으로만 호출할 수 있다. */
  step(tMs: number): PlantStep;
}

export interface PlantOptions {
  readonly site: SiteDef;
  readonly seed: number;
  /** 초기 상태의 시각. 첫 step은 startMs + stepS */
  readonly startMs: number;
  readonly stepS: number;
  readonly plan?: SiteScenarioPlan;
}

type SourcePoint = Pick<PointDef, 'sourceKey' | 'sourceUnit' | 'scale' | 'valueOffset' | 'periodS'>;

interface SampledPoint {
  readonly assetCode: string;
  readonly key: string;
  readonly point: SourcePoint;
  readonly metric: MetricDef;
  readonly mapped: boolean;
  readonly periodMs: number;
}

interface PlantState {
  readonly tMs: number;
  readonly inverters: readonly InverterUnit[];
  readonly ess: EssUnit | null;
  readonly hydrogen: HydrogenUnit | null;
  readonly meter: MeterUnit;
  readonly ems: EmsMemory;
}

function metricOf(metricKey: string, where: string): MetricDef {
  const metric = METRIC_DEF_BY_KEY.get(metricKey);
  if (!metric) throw new Error(`카탈로그에 없는 메트릭: ${metricKey} (${where})`);
  return metric;
}

function sampledPoints(site: SiteDef, stepS: number): readonly SampledPoint[] {
  const mapped = site.assets.flatMap((asset) =>
    asset.points.map((point): SampledPoint => ({
      assetCode: asset.code,
      key: readingKey(point.metricKey, point.qualifier),
      point,
      metric: metricOf(point.metricKey, point.sourceKey),
      mapped: true,
      periodMs: point.periodS * MS_PER_SECOND,
    })),
  );
  const unmapped = site.unmappedTags.map((tag): SampledPoint => ({
    assetCode: tag.assetCode,
    key: tag.metricKey,
    point: { sourceKey: tag.sourceKey, sourceUnit: tag.unit, scale: 1, valueOffset: 0, periodS: tag.periodS },
    metric: metricOf(tag.metricKey, tag.sourceKey),
    mapped: false,
    periodMs: tag.periodS * MS_PER_SECOND,
  }));
  const all = [...mapped, ...unmapped];
  const misaligned = all.find((p) => p.point.periodS % stepS !== 0);
  if (misaligned) throw new Error(`stepS(${stepS})가 ${misaligned.point.sourceKey} 주기(${misaligned.point.periodS}s)의 약수가 아닙니다`);
  return all;
}

function siteLayout(site: SiteDef): SiteLayout {
  const layout = site.attributes.layout;
  if (layout !== 'pv_ess' && layout !== 'integrated') throw new Error(`${site.code} layout을 알 수 없습니다: ${String(layout)}`);
  return layout;
}

/** 누출 경보 시 검지 농도 추가분 [ppm]: 3분에 걸쳐 1차 경보치(4,000) 도달 → 6,500 유지 → 격리·환기로 감소 */
export function leakExtraPpm(tMs: number, alarmAtMs: number): number {
  const minutes = (tMs - alarmAtMs) / MS_PER_MINUTE;
  if (minutes < -3 || minutes > 105) return 0;
  if (minutes < 0) return (4_000 * (minutes + 3)) / 3;
  if (minutes < 3) return 4_000 + (2_500 * minutes) / 3;
  if (minutes < 8) return 6_500;
  return 6_500 * Math.exp(-(minutes - 8) / 10);
}

function createSensor(seed: number, site: SiteDef, plan: SiteScenarioPlan) {
  const noiseRng = deriveRng(seed, site.code, 'noise');
  const spikeRngs = new Map<string, Rng>(plan.spikes.map((s) => [s.sourceKey, deriveRng(seed, site.code, 'spike', s.sourceKey)]));
  const heldValues = new Map<string, number>(); // 고착 구간에서 처음 읽은 값
  return (sp: SampledPoint, canonical: number, tMs: number): number => {
    const key = sp.point.sourceKey;
    const noisy = addNoise(sp.metric, canonical, noiseRng); // 고착 중에도 뽑아 난수열을 고정한다
    const spike = plan.spikes.find((s) => s.sourceKey === key);
    const spikeRng = spikeRngs.get(key);
    const spiked =
      spike && spikeRng && spikeRng.chance((spike.perDay * sp.point.periodS) / SECONDS_PER_DAY)
        ? spikeValue(sp.metric, noisy, spike.magnitude, spikeRng)
        : noisy;
    const raw = formatRaw(sp.metric, sp.point, spiked);
    const stuck = plan.stuckSensors.some((s) => s.sourceKey === key && tMs >= s.startMs && tMs < s.endMs);
    if (!stuck) {
      heldValues.delete(key);
      return raw;
    }
    const held = heldValues.get(key) ?? raw;
    heldValues.set(key, held);
    return held;
  };
}

interface AdvanceDeps {
  readonly layout: SiteLayout;
  readonly eventsRng: Rng;
}

/** 대조군 조건(한파 주간)의 배터리실 온도 편차를 반영한 배터리실 기후 */
function roomClimate(ctx: StepContext, controls: StepControls): RoomClimate {
  const room = batteryRoom(ctx.weather.ambientC, ctx.weather.humidityPct);
  return { ...room, tempC: room.tempC + controls.roomDeltaC };
}

/** 전해조 부분부하 대조군: EMS가 보는 정격을 줄여 지령 상한을 낮춘다. */
const capElectrolyzer = (view: HydrogenView, loadCap: number): HydrogenView =>
  loadCap < 1 ? { ...view, elzRatedKw: view.elzRatedKw * loadCap } : view;

interface StepConditions {
  readonly lockout: boolean;
  readonly controls: StepControls;
  readonly room: RoomClimate;
}

/** 물리 상태를 한 스텝 전진: PV → EMS 지령 → ESS·수소 설비 → 계량기 */
function advancePlant(state: PlantState, ctx: StepContext, deps: AdvanceDeps, conditions: StepConditions): { next: PlantState; events: readonly SimEvent[] } {
  const { lockout, controls, room } = conditions;
  const auxKw = AUX_KW[deps.layout];
  const pv = stepInverters(state.inverters, ctx, deps.eventsRng);
  const decision = dispatch(
    {
      layout: deps.layout,
      localHour: kstHourOfDay(ctx.tMs),
      dtS: ctx.dtS,
      pvAcKw: pv.acKw,
      auxKw,
      ess: state.ess ? essView(state.ess) : null,
      hydrogen: state.hydrogen ? capElectrolyzer(hydrogenView(state.hydrogen), controls.elzLoadCap) : null,
      safetyLockout: lockout,
      socMax: controls.socMax,
      fcCycling: controls.fcCycling,
      elzTopoff: ctx.p3.elzTopoff,
    },
    state.ems,
  );
  const ess = state.ess ? stepEss(state.ess, decision.essAcKw, room, ctx) : null;
  const h2 = state.hydrogen ? stepHydrogen(state.hydrogen, decision, ctx, lockout) : null;
  const hydrogenNetKw = h2 ? h2.fcAcKw - h2.elzAcKw - h2.compressorKw : 0;
  const netKw = pv.acKw + (ess?.acKw ?? 0) + hydrogenNetKw - auxKw;
  const next: PlantState = {
    tMs: ctx.tMs,
    inverters: pv.units,
    ess,
    hydrogen: h2?.unit ?? null,
    meter: stepMeter(state.meter, netKw, ctx.dtS),
    ems: decision.memory,
  };
  return { next, events: [...pv.events, ...(h2?.events ?? [])] };
}

function plantReadings(site: SiteDef, plan: SiteScenarioPlan, state: PlantState, ctx: StepContext, room: RoomClimate): ReadonlyMap<string, AssetReadings> {
  const extraPpm = (detector: string) =>
    plan.leakAlarms.filter((a) => a.detector === detector).reduce((sum, a) => sum + leakExtraPpm(ctx.tMs, a.atMs), 0);
  return new Map([
    ...inverterReadings(state.inverters, ctx),
    ...(state.ess ? essReadings(state.ess, room) : []),
    ...(state.hydrogen ? hydrogenReadings(state.hydrogen, ctx, extraPpm) : []),
    ...siteCommonReadings(site, state.meter, ctx),
  ]);
}

type Sensor = ReturnType<typeof createSensor>;

function samplePoints(site: SiteDef, points: readonly SampledPoint[], readings: ReadonlyMap<string, AssetReadings>, tMs: number, sensor: Sensor): PlantSample[] {
  return points
    .filter((sp) => tMs % sp.periodMs === 0)
    .map((sp) => {
      const canonical = readings.get(sp.assetCode)?.[sp.key];
      if (canonical === undefined || !Number.isFinite(canonical)) {
        throw new Error(`시뮬레이터가 값을 만들지 않은 포인트: ${site.code} ${sp.point.sourceKey} (${sp.key}=${String(canonical)})`);
      }
      return { sourceKey: sp.point.sourceKey, unit: sp.point.sourceUnit, periodS: sp.point.periodS, ts: tMs, value: sensor(sp, canonical, tMs), mapped: sp.mapped };
    });
}

/** 계통 주파수·전압의 느린 흔들림 (사이트 공통) */
const gridConditions = (tMs: number): Pick<StepContext, 'gridFrequencyHz' | 'gridVoltageFactor'> => ({
  gridFrequencyHz: 60 + 0.012 * Math.sin((2 * Math.PI * tMs) / (17 * MS_PER_MINUTE)) + 0.006 * Math.sin((2 * Math.PI * tMs) / (187 * MS_PER_SECOND)),
  gridVoltageFactor: 1 + 0.006 * Math.sin((2 * Math.PI * tMs) / (6 * MS_PER_HOUR)),
});

function initialState(site: SiteDef, seed: number, startMs: number): PlantState {
  const commissionedAt = site.assets[0]?.commissionedAt;
  if (!commissionedAt) throw new Error(`${site.code}에 설비가 없습니다`);
  const daysInService = Math.max(0, (startMs - kstDateToMs(commissionedAt)) / MS_PER_DAY);
  const init = { site, daysInService, rng: deriveRng(seed, site.code, 'static') };
  return {
    tMs: startMs,
    inverters: createInverters(init),
    ess: createEss(init),
    hydrogen: createHydrogen(init),
    meter: createMeter(site, daysInService),
    ems: INITIAL_EMS_MEMORY,
  };
}

export function createPlant(options: PlantOptions): Plant {
  const { site, seed, startMs, stepS } = options;
  if (!Number.isInteger(stepS) || stepS <= 0) throw new Error(`stepS는 양의 정수여야 합니다: ${stepS}`);
  const plan = options.plan ?? EMPTY_PLAN;
  const stepMs = stepS * MS_PER_SECOND;
  const points = sampledPoints(site, stepS);
  const degradation = createDegradationResolver(plan.faults);
  const tiltDeg = assetsOfClass(site, 'pv.plant')[0]?.nameplate.tilt_deg;
  const weather = createWeather(site, seed, typeof tiltDeg === 'number' ? tiltDeg : undefined, [...weatherWindowsOf(plan), ...p3WeatherWindows(plan)]);
  const deps: AdvanceDeps = { layout: siteLayout(site), eventsRng: deriveRng(seed, site.code, 'events') };
  const sensor = createSensor(seed, site, plan);
  let state = initialState(site, seed, startMs);

  return {
    site,
    stepS,
    step(tMs: number): PlantStep {
      if (tMs !== state.tMs + stepMs) throw new Error(`${site.code} 스텝 순서 오류: ${state.tMs} 다음은 ${state.tMs + stepMs}인데 ${tMs}`);
      const controls = controlsAt(plan, tMs);
      const ctx: StepContext = { tMs, dtS: stepS, weather: weather.sample(tMs), degradation, ...gridConditions(tMs), pvLimitPct: controls.pvLimitPct, p3: p3ControlsAt(plan, tMs) };
      const lockout = plan.leakAlarms.some((a) => tMs >= a.atMs && tMs < a.atMs + SAFETY_LOCKOUT_MS);
      const room = roomClimate(ctx, controls);
      const { next, events } = advancePlant(state, ctx, deps, { lockout, controls, room });
      state = next;
      const alarms = plan.leakAlarms
        .filter((a) => a.atMs > tMs - stepMs && a.atMs <= tMs)
        .map((a) => safetyAlarm(a.detector, tMs, EVENT_CODE.H2_LEAK_L1, '수소 누출 1차 경보 (4,000 ppm 이상)'));
      const readings = plantReadings(site, plan, next, ctx, room);
      return { tMs, samples: samplePoints(site, points, readings, tMs, sensor), events: [...events, ...alarms], readings };
    },
  };
}
