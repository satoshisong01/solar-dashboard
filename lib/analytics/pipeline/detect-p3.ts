// P3 탐지기 8종 입력 조립 (순수). 에피소드는 스냅샷, 에피소드가 아닌 입력(정지 구간 원시 점·열 저감 표본·정류기 효율·원장 일 행)은 snapshot.aux.
//   설비 단위: el.sec_rise(전해조 스택) · tank.static_leak(저장용기) · comp.sec_rise(압축기) · fc.blower_wear(블로워) · ess.resistance_growth(랙)
//   사이트 단위: pv.soiling_rate(pv.plant 설비가 있으면 그 설비, 없으면 사이트) · inv.thermal_derating(인버터 동종 비교, finding은 인버터) · h2chain.mass_balance_gap(사이트)
import { compSecRise } from '../detectors/comp-sec-rise';
import { elSecRise } from '../detectors/el-sec-rise';
import { essResistanceGrowth, type EssResistanceInput } from '../detectors/ess-resistance-growth';
import { fcBlowerWear } from '../detectors/fc-blower-wear';
import { h2ChainMassBalanceGap, type StaticLeakCrossCheck } from '../detectors/h2chain-mass-balance';
import { invThermalDerating } from '../detectors/inv-thermal-derating';
import { pvSoilingRate } from '../detectors/pv-soiling-rate';
import { tankStaticLeak, type TankHoldInput } from '../detectors/tank-static-leak';
import { assetTarget, isTarget, latestReset, runOne, targetsOfClass, type DetectOptions, type P3PipelineDetectorId, type Runner } from './detect-common';
import { massBalanceDays } from './site-ledger';
import type { SnapshotIndex } from './snapshot';
import type { DetectorOutcome, PipelineAsset } from './types';

const num = (asset: PipelineAsset, key: string): number | null => {
  const value = Number(asset.nameplate[key]);
  return asset.nameplate[key] !== undefined && asset.nameplate[key] !== null && Number.isFinite(value) ? value : null;
};

const common = (index: SnapshotIndex, options: DetectOptions, asset: PipelineAsset) => ({ configTarget: assetTarget(asset), assetId: asset.id, baselineResetAt: index.baselineResetAt(asset.id, options.now) });

const elSecRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'h2.elz.stack').map((stack) =>
    runOne(index, options, {
      ...common(index, options, stack),
      detector: elSecRise,
      input: {
        assetId: stack.id,
        nameplate: { cellCount: num(stack, 'cell_count') ?? 0, activeAreaCm2: num(stack, 'active_area_cm2') ?? 0, ratedCurrentA: num(stack, 'rated_current_a') ?? 0 },
        episodes: index.episodesOf(stack.id, 'el.steady_run'),
        rectifierEfficiency: index.snapshot.aux?.rectifierEfficiency?.get(stack.id),
      },
    }),
  );

/** 정지 보유 구간 에피소드 + 원시 점. 점이 없는 구간은 뺀다 (load 계층은 선택한 구간만 원시를 읽는다) */
function holdsOf(index: SnapshotIndex, tank: PipelineAsset): TankHoldInput[] {
  const points = index.snapshot.aux?.tankHoldPoints?.get(tank.id);
  return index.episodesOf(tank.id, 'tank.hold').flatMap((e) => {
    const holdPoints = e.valid ? points?.get(e.start) : undefined;
    return holdPoints === undefined ? [] : [{ start: e.start, end: e.end, completeness: e.dq.completeness, points: holdPoints, downstreamRiseBar: e.features.downstream_p_rise_bar }];
  });
}

const tankLeakRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'h2.storage.tank').map((tank) =>
    runOne(index, options, { ...common(index, options, tank), detector: tankStaticLeak, input: { assetId: tank.id, waterVolumeL: num(tank, 'water_volume_l') ?? 0, holds: holdsOf(index, tank) } }),
  );

const compRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'h2.compressor').map((comp) => runOne(index, options, { ...common(index, options, comp), detector: compSecRise, input: { assetId: comp.id, episodes: index.episodesOf(comp.id, 'comp.run') } }));

const blowerRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'fc.blower').map((blower) => {
    const stack = index.assetsOfClass('fc.stack').find((s) => s.parentId === blower.parentId);
    return runOne(index, options, {
      ...common(index, options, blower),
      detector: fcBlowerWear,
      input: { assetId: blower.id, runs: index.episodesOf(blower.id, 'fc.blower_run'), events: index.eventsFor(blower.id), stackEpisodes: stack ? index.episodesOf(stack.id, 'fc.steady_run') : undefined },
    });
  });

const CLEANING_NOTE = /세척|clean/i;

const soilingRuns: Runner = (index, options) => {
  const inverters = index.assetsOfClass('pv.inverter');
  const station = index.assetsOfClass('wx.station')[0];
  const plant = index.assetsOfClass('pv.plant')[0];
  const members = plant ? [plant, ...inverters] : inverters;
  if (inverters.length === 0 || !station || !members.some((a) => isTarget(options, a.id))) return [];
  const memberIds = new Set(members.map((a) => a.id));
  const eventCleaning = index.snapshot.events.filter((e) => memberIds.has(e.assetId) && (e.kind === 'maintenance' || e.kind === 'other') && CLEANING_NOTE.test(e.note ?? '')).map((e) => e.ts);
  const aux = index.snapshot.aux;
  return [
    runOne(index, options, {
      detector: pvSoilingRate,
      configTarget: plant ? assetTarget(plant) : { id: null, classKey: 'pv.plant' },
      // 사이트 단위 탐지기: 설정은 발전소 설비 범위까지 적용하되 finding은 설비 없이(dedup site:<id>) 남긴다
      assetId: null,
      baselineResetAt: latestReset(index, members, options.now),
      input: {
        siteId: index.snapshot.siteId,
        assetId: null,
        gammaPerC: plant ? num(plant, 'gamma_per_c') : null,
        inverterDays: inverters.flatMap((inv) => index.episodesOf(inv.id, 'pv.day')),
        wxDays: index.episodesOf(station.id, 'wx.day'),
        cleaningTs: [...new Set([...eventCleaning, ...(aux?.cleaningTs ?? [])])].sort((a, b) => a - b),
        smpKrwPerKwh: aux?.smpKrwPerKwh ?? null,
      },
    }),
  ];
};

/** 같은 랙 ess.capacity_fade 결과: finding이면 효과, 판정했지만 finding이 없으면 0, 판정 불능이면 null */
function capacityOf(prior: readonly DetectorOutcome[], rackId: number): EssResistanceInput['capacityFade'] {
  const outcome = prior.find((o) => o.detectorId === 'ess.capacity_fade' && o.assetId === rackId);
  if (!outcome || outcome.status !== 'ok') return null;
  const finding = outcome.findings[0];
  return finding ? { effectPct: finding.effect.value, ciHighPct: finding.effect.ciHigh } : { effectPct: 0, ciHighPct: null };
}

const resistanceRuns: Runner = (index, options, prior) =>
  targetsOfClass(index, options, 'ess.rack').map((rack) =>
    runOne(index, options, { ...common(index, options, rack), detector: essResistanceGrowth, input: { assetId: rack.id, steps: index.episodesOf(rack.id, 'ess.current_step'), capacityFade: capacityOf(prior, rack.id) } }),
  );

const thermalRuns: Runner = (index, options) => {
  const inverters = index.assetsOfClass('pv.inverter');
  if (inverters.length === 0 || !inverters.some((inv) => isTarget(options, inv.id))) return [];
  const aux = index.snapshot.aux;
  return [
    runOne(index, options, {
      detector: invThermalDerating,
      configTarget: { id: null, classKey: 'pv.inverter' },
      assetId: null,
      baselineResetAt: latestReset(index, inverters, options.now),
      input: {
        siteId: index.snapshot.siteId,
        inverters: inverters.map((inv) => ({ assetId: inv.id, dcKwp: num(inv, 'dc_kwp') ?? 0, derateStartC: num(inv, 'derate_start_c') })),
        samples: aux?.thermalSamples ?? [],
        faultEvents: aux?.inverterFaultEvents,
      },
      keep: (finding) => finding.assetId !== null && isTarget(options, finding.assetId),
    }),
  ];
};

const H2_CHAIN_CLASSES: readonly string[] = ['h2.elz', 'h2.storage.tank', 'fc.plant'];

/** 사이트 저장용기 누설 판정 요약 (누설률이 가장 큰 finding) */
function staticLeakOf(prior: readonly DetectorOutcome[], siteId: number): StaticLeakCrossCheck | null {
  const outcomes = prior.filter((o) => o.detectorId === 'tank.static_leak' && o.siteId === siteId);
  if (outcomes.length === 0) return null;
  const worst = outcomes.flatMap((o) => o.findings).sort((a, b) => b.effect.value - a.effect.value)[0];
  if (worst) return { status: 'finding', leakKgPerDay: worst.effect.value, ciLowKgPerDay: worst.effect.ciLow };
  return outcomes.some((o) => o.status === 'ok') ? { status: 'no_finding', leakKgPerDay: null, ciLowKgPerDay: null } : { status: 'insufficient', leakKgPerDay: null, ciLowKgPerDay: null };
}

const massBalanceRuns: Runner = (index, options, prior) => {
  const chain = index.snapshot.assets.filter((a) => H2_CHAIN_CLASSES.includes(a.classKey));
  const ledgerDays = index.snapshot.aux?.ledgerDays;
  if (chain.length === 0 || ledgerDays === undefined || !chain.some((a) => isTarget(options, a.id))) return [];
  return [
    runOne(index, options, {
      detector: h2ChainMassBalanceGap,
      configTarget: null,
      assetId: null,
      baselineResetAt: latestReset(index, chain, options.now),
      input: { siteId: index.snapshot.siteId, days: massBalanceDays(ledgerDays), staticLeak: staticLeakOf(prior, index.snapshot.siteId) },
    }),
  ];
};

export const P3_RUNNERS: Readonly<Record<P3PipelineDetectorId, Runner>> = {
  'el.sec_rise': elSecRuns,
  'tank.static_leak': tankLeakRuns,
  'comp.sec_rise': compRuns,
  'fc.blower_wear': blowerRuns,
  'pv.soiling_rate': soilingRuns,
  'ess.resistance_growth': resistanceRuns,
  'inv.thermal_derating': thermalRuns,
  'h2chain.mass_balance_gap': massBalanceRuns,
};
