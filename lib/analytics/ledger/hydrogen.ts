// 수소 원장 (순수): 생산 + 외부 반입 − 연료전지 소비 − 저장량 변화 − 배출 추정 = 잔차 (설계 §3 체인 원장, research-system H1~H6 수지식).
//
// 계량점
//   produced     = 전해조 적산계 h2.mass.total 하루 증가량(method=meter_total). 적산계가 없거나 경계 행이 없거나 그날 값이 줄면(리셋·교체)
//                  h2.flow.mass 시간 평균 적산(method=meter), 유량계도 없으면 패러데이 추정 N_cell × I × η_F × 3.7608e-5 kg/(A·h) (method=faraday_estimate)
//                  적산계를 먼저 쓰는 이유: 5분 순시 유량 표본의 시간 평균은 기동·정지가 표본 사이에 걸리면 한 번에 최대 (유량 × 표본 간격)만큼 틀린다.
//   delivered    = 외부 반입량. 1순위 하역 적산계 h2.delivery.mass.total 하루 증가량(method=meter), 2순위 반입 기록(om.h2_delivery) 그날 합계(method=invoice).
//                  반입 설비(h2.delivery)가 없는 사이트는 0이다. 반입 설비가 있는데 계량·기록이 둘 다 없는 날은 0이 아니라 null — 판정 불능이다.
//                  0으로 채우면 반입분이 통째로 음(−)의 잔차가 되어 반입 사이트에서 상시 오경보가 난다 (docs/renewal/research/pid/research-supply.md §2.2).
//   fc_consumed  = 연료전지 fc.h2.consumption 적산
//   stored_delta = 저장용기마다 (끝 P·T → 실기체 질량) − (시작 P·T → 질량) 의 합. 상태식 NIST Lemmon 2008 (tank.static_leak 기본과 같다)
//   vented_est   = purge.count 증가 × params.kgPerPurge + params.dryerLossFraction × produced (기본 0 = 추정 안 함)
//   residual     = produced + delivered − fc_consumed − stored_delta − vented_est
//   residual_pct = residual / max(produced + delivered, fc_consumed, params.residualFloorKg) × 100
// 한계: 시간 평균 × 1 h 적산이다. 유량계 행이 빠진 시간은 0으로 더해지므로 잔차를 보기 전에 dq.h2.completeness를 확인한다. 탱크 압력은 절대압으로 본다(게이지압이면 약 1 bar 해당 질량이 일정하게 편향되지만 차분에서는 대부분 상쇄).
//       충전·방출 직후 가스 온도와 센서 온도 차이는 재고를 흔든다(하루 끝·시작이 정지 구간일 때 가장 정확하다).
import { H2_EOS_VERSION, H2_KG_PER_AMP_HOUR_PER_CELL, LEMMON_EOS } from '../detectors/hydrogen-eos';
import { MS_PER_HOUR } from '../types';
import { assetsOf, dayBoundary, dayCompleteness, goodAvg, hasDayData, hourIntegral, hourMax, hourMin, meanOrNull, nameplateNumber, round, roundOrNull, type LedgerContext } from './hourly';
import type { LedgerParams } from './params';
import type { H2DeliveredMethod, H2Ledger, H2ProducedMethod, SiteEnergyDq } from './types';

// 상태식·패러데이 상수는 tank.static_leak 탐지기와 같은 정의(detectors/hydrogen-eos.ts) 하나만 쓴다.
export { H2_EOS_VERSION, H2_KG_PER_AMP_HOUR_PER_CELL };

const sumHours = (ctx: LedgerContext, classKey: string, metricKey: string, perHour: (value: number, assetId: number) => number): number =>
  assetsOf(ctx, classKey).reduce((sum, asset) => sum + ctx.hours.reduce((acc, h) => {
    const value = hourIntegral(ctx.row(asset.id, metricKey, h));
    return value === null ? acc : acc + perHour(value, asset.id);
  }, 0), 0);

interface Produced {
  readonly kg: number | null;
  readonly method: H2ProducedMethod | null;
  readonly completeness: number | null;
}

/** 스택 전류로 계산한 이론 생산량 [kg] (셀 수 × 전류 × η_F × 원단위). 전류 데이터·셀 수가 없으면 null */
function faradayKg(ctx: LedgerContext, efficiency: number): number | null {
  const stacks = assetsOf(ctx, 'h2.elz.stack');
  if (!hasDayData(ctx, 'h2.elz.stack', 'stack.current') || stacks.some((s) => nameplateNumber(s, 'cell_count') === null)) return null;
  const cells = new Map(stacks.map((s) => [s.id, nameplateNumber(s, 'cell_count') ?? 0]));
  return ctx.hours.reduce((sum, h) => sum + stacks.reduce((acc, s) => {
    const current = goodAvg(ctx.row(s.id, 'stack.current', h));
    return current === null ? acc : acc + (cells.get(s.id) ?? 0) * Math.max(0, current) * efficiency * H2_KG_PER_AMP_HOUR_PER_CELL;
  }, 0), 0);
}

/**
 * 적산계 하루 증가량 [kg]: 앞 1시간 행 last(없으면 0시 행 first) → 23시 행 last.
 * 0시·23시 경계 행이 없거나, 시간 안(최솟값 < 직전 값 · 최댓값 > 끝값)이나 시간 사이에서 값이 줄면(리셋·교체) null.
 */
export function counterDayDelta(ctx: LedgerContext, assetId: number, metricKey: string): number | null {
  const good = (hourStart: number) => {
    const r = ctx.row(assetId, metricKey, hourStart);
    return r !== undefined && r.nGood > 0 ? r : undefined;
  };
  const rows = ctx.hours.map(good);
  const start = good(ctx.dayStart - MS_PER_HOUR)?.last ?? rows[0]?.first ?? null;
  const end = rows[rows.length - 1]?.last ?? null;
  if (start === null || end === null) return null;
  let previous = start;
  for (const r of rows) {
    if (r === undefined || r.last === null) continue;
    const tolerance = 1e-9 * Math.abs(previous) + 1e-6;
    if ((hourMin(r) ?? r.last) < previous - tolerance || (hourMax(r) ?? r.last) > r.last + tolerance) return null;
    previous = r.last;
  }
  return end - start;
}

function counterProduced(ctx: LedgerContext): Produced | null {
  const units = assetsOf(ctx, 'h2.elz');
  if (units.length === 0 || !hasDayData(ctx, 'h2.elz', 'h2.mass.total')) return null;
  const deltas = units.map((unit) => counterDayDelta(ctx, unit.id, 'h2.mass.total'));
  if (deltas.some((d) => d === null)) return null;
  return { kg: deltas.reduce<number>((sum, d) => sum + (d ?? 0), 0), method: 'meter_total', completeness: dayCompleteness(ctx, 'h2.elz', 'h2.mass.total') };
}

function produced(ctx: LedgerContext, params: LedgerParams): Produced {
  const counter = counterProduced(ctx);
  if (counter !== null) return counter;
  if (hasDayData(ctx, 'h2.elz', 'h2.flow.mass')) {
    return { kg: sumHours(ctx, 'h2.elz', 'h2.flow.mass', (v) => Math.max(0, v)), method: 'meter', completeness: dayCompleteness(ctx, 'h2.elz', 'h2.flow.mass') };
  }
  const kg = faradayKg(ctx, params.faradayEfficiency);
  return kg === null ? { kg: null, method: null, completeness: null } : { kg, method: 'faraday_estimate', completeness: dayCompleteness(ctx, 'h2.elz.stack', 'stack.current') };
}

export interface Delivered {
  /** 외부 반입량 [kg]. null = 판정 불능 (반입 설비는 있는데 그날 계량·기록이 없다) */
  readonly kg: number | null;
  readonly method: H2DeliveredMethod | null;
  /** 반입 설비가 있어 반입량을 알아야 하는 사이트인가 */
  readonly expected: boolean;
}

/**
 * 하루 외부 반입량. 1순위 하역 적산계 증가량, 2순위 반입 기록(전표) 합계.
 * 반입 설비(h2.delivery)가 없고 그날 반입 기록도 없으면 0이다 — 반입이 없는 사이트는 기존과 같이 계산된다.
 */
export function deliveredKg(ctx: LedgerContext, invoiceKg: number | null): Delivered {
  const units = assetsOf(ctx, 'h2.delivery');
  const expected = units.length > 0;
  if (units.length > 0 && hasDayData(ctx, 'h2.delivery', 'h2.delivery.mass.total')) {
    const deltas = units.map((unit) => counterDayDelta(ctx, unit.id, 'h2.delivery.mass.total'));
    if (deltas.every((d) => d !== null)) return { kg: deltas.reduce<number>((sum, d) => sum + (d ?? 0), 0), method: 'meter', expected };
  }
  if (invoiceKg !== null) return { kg: invoiceKg, method: 'invoice', expected };
  return expected ? { kg: null, method: null, expected } : { kg: 0, method: null, expected };
}

/** 저장부 유입·유출 신호 (tank.hold 정지 판정과 같은 기준: 유량 0.05 kg/h 이하·압축기 1 kW 이하) */
const STORAGE_FLOW_SIGNALS: readonly (readonly [classKey: string, metricKey: string, idleMax: number])[] = [
  ['h2.elz', 'h2.flow.mass', 0.05],
  ['fc.plant', 'fc.h2.consumption', 0.05],
  ['h2.compressor', 'compressor.power', 1],
];

/**
 * 경계 시간이 정지 시간인지: 사이트에 있는 유입·유출 신호가 모두 그 시간 내내 멈춰 있음(시간 최댓값 기준).
 * 신호 설비는 있는데 그 시간 행이 없으면 정지로 보지 않는다. 신호가 하나도 없으면 판단할 수 없어 false.
 */
export function storageStaticHour(ctx: LedgerContext): (hourStart: number) => boolean {
  const signals = STORAGE_FLOW_SIGNALS.flatMap(([classKey, metricKey, idleMax]) => assetsOf(ctx, classKey).map((asset) => ({ assetId: asset.id, metricKey, idleMax })));
  return (hourStart) =>
    signals.length > 0 &&
    signals.every(({ assetId, metricKey, idleMax }) => {
      const max = hourMax(ctx.row(assetId, metricKey, hourStart));
      return max !== null && Math.abs(max) <= idleMax && Math.abs(hourMin(ctx.row(assetId, metricKey, hourStart)) ?? Infinity) <= idleMax;
    });
}

/** 저장용기별 끝·시작 질량 차의 합. 용기가 없거나 한 용기라도 P·T 경계값·내용적이 없으면 null. 경계 시간이 정지 시간이면 P·T 시간 평균을 쓴다 */
export function storedDeltaKg(ctx: LedgerContext): number | null {
  const tanks = assetsOf(ctx, 'h2.storage.tank');
  if (tanks.length === 0) return null;
  const isStatic = storageStaticHour(ctx);
  const deltas = tanks.map((tank) => {
    const volumeL = nameplateNumber(tank, 'water_volume_l');
    const p = dayBoundary(ctx, tank.id, 'tank.pressure', isStatic);
    const t = dayBoundary(ctx, tank.id, 'tank.temp', isStatic);
    if (volumeL === null || p.start === null || p.end === null || t.start === null || t.end === null) return null;
    const volumeM3 = volumeL / 1000;
    return LEMMON_EOS.mass(p.end, t.end, volumeM3) - LEMMON_EOS.mass(p.start, t.start, volumeM3);
  });
  return deltas.some((d) => d === null) ? null : deltas.reduce<number>((sum, d) => sum + (d ?? 0), 0);
}

/** 저장용기 가스 온도 하루 끝 − 시작의 평균 [°C] (물질수지 온도 보정 판별 체크용). 경계값이 있는 용기가 없으면 null */
function tankTempDeltaC(ctx: LedgerContext): number | null {
  return meanOrNull(assetsOf(ctx, 'h2.storage.tank').map((tank) => {
    const t = dayBoundary(ctx, tank.id, 'tank.temp');
    return t.start === null || t.end === null ? null : t.end - t.start;
  }));
}

function purgeCount(ctx: LedgerContext): number | null {
  const plants = assetsOf(ctx, 'fc.plant');
  const counts = plants.map((plant) => {
    const b = dayBoundary(ctx, plant.id, 'purge.count');
    return b.start === null || b.end === null ? null : Math.max(0, b.end - b.start); // 음수 = 카운터 리셋 → 그날은 0으로 본다
  });
  return plants.length === 0 || counts.some((c) => c === null) ? null : counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
}

export interface HydrogenDay {
  readonly ledger: H2Ledger;
  readonly dq: SiteEnergyDq['h2'];
}

/**
 * 하루 수소 원장. 수소 설비가 없는 사이트는 모든 값이 null.
 * invoiceKg는 그날(KST) 반입 기록(om.h2_delivery) 합계다 — 기록이 한 건도 없는 날은 null을 넣는다(0이 아니다).
 */
export function hydrogenLedger(ctx: LedgerContext, params: LedgerParams, invoiceKg: number | null = null): HydrogenDay {
  const made = produced(ctx, params);
  const delivery = deliveredKg(ctx, invoiceKg);
  const fcMeasured = hasDayData(ctx, 'fc.plant', 'fc.h2.consumption');
  const fcConsumed = fcMeasured ? sumHours(ctx, 'fc.plant', 'fc.h2.consumption', (v) => Math.max(0, v)) : null;
  const stored = storedDeltaKg(ctx);
  const purges = purgeCount(ctx);
  const ventedEstimated = params.kgPerPurge > 0 || params.dryerLossFraction > 0;
  const vented = (purges ?? 0) * params.kgPerPurge + params.dryerLossFraction * (made.kg ?? 0);
  const supplied = made.kg === null || delivery.kg === null ? null : made.kg + delivery.kg;
  const residual = supplied === null || fcConsumed === null || stored === null ? null : supplied - fcConsumed - stored - vented;
  const denominator = Math.max(supplied ?? 0, fcConsumed ?? 0, params.residualFloorKg);
  const hasHydrogen = assetsOf(ctx, 'h2.elz').length > 0 || assetsOf(ctx, 'fc.plant').length > 0;

  return {
    ledger: {
      produced: roundOrNull(made.kg, 4),
      delivered: roundOrNull(delivery.kg, 4),
      fc_consumed: roundOrNull(fcConsumed, 4),
      stored_delta: roundOrNull(stored, 4),
      vented_est: hasHydrogen ? round(vented, 4) : null,
      residual: roundOrNull(residual, 4),
      residual_pct: residual === null ? null : round((residual / denominator) * 100, 3),
      method: {
        produced: made.method,
        delivered: delivery.method,
        fc_consumed: fcMeasured ? 'meter' : null,
        stored_delta: stored === null ? null : H2_EOS_VERSION,
        vented: ventedEstimated ? 'params' : 'not_estimated',
      },
      aux: {
        faraday_expected: roundOrNull(hasHydrogen ? faradayKg(ctx, 1) : null, 4),
        purge_count: purges,
        tank_temp_delta_c: roundOrNull(tankTempDeltaC(ctx), 3),
      },
    },
    dq: {
      completeness: roundOrNull(
        meanOrNull([
          made.completeness,
          delivery.method === 'meter' ? dayCompleteness(ctx, 'h2.delivery', 'h2.delivery.mass.total') : null,
          fcMeasured ? dayCompleteness(ctx, 'fc.plant', 'fc.h2.consumption') : null,
          dayCompleteness(ctx, 'h2.storage.tank', 'tank.pressure'),
          dayCompleteness(ctx, 'h2.storage.tank', 'tank.temp'),
        ]),
        4,
      ),
      purge_count_missing: params.kgPerPurge > 0 && purges === null,
      delivered_missing: delivery.expected && delivery.kg === null,
    },
  };
}
