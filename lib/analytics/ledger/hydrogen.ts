// 수소 원장 (순수): 생산 − 연료전지 소비 − 저장량 변화 − 배출 추정 = 잔차 (설계 §3 체인 원장, research-system H1~H6 수지식).
//
// 계량점
//   produced     = 전해조 h2.flow.mass 적산. 유량계가 없으면 패러데이 추정 N_cell × I × η_F × 3.7608e-5 kg/(A·h) (method=faraday_estimate)
//   fc_consumed  = 연료전지 fc.h2.consumption 적산
//   stored_delta = 저장용기마다 (끝 P·T → 실기체 질량) − (시작 P·T → 질량) 의 합. 상태식 Abel–Noble (아래)
//   vented_est   = purge.count 증가 × params.kgPerPurge + params.dryerLossFraction × produced (기본 0 = 추정 안 함)
//   residual     = produced − fc_consumed − stored_delta − vented_est
//   residual_pct = residual / max(produced, fc_consumed, params.residualFloorKg) × 100
// 한계: 시간 평균 × 1 h 적산이다. 유량계 행이 빠진 시간은 0으로 더해지므로 잔차를 보기 전에 dq.h2.completeness를 확인한다. 탱크 압력은 절대압으로 본다(게이지압이면 약 1 bar 해당 질량이 일정하게 편향되지만 차분에서는 대부분 상쇄).
//       충전·방출 직후 가스 온도와 센서 온도 차이는 재고를 흔든다(하루 끝·시작이 정지 구간일 때 가장 정확하다).
import { h2MassKg, H2_EOS_VERSION, H2_KG_PER_AMP_HOUR_PER_CELL } from '../detectors/hydrogen-eos';
import { assetsOf, dayBoundary, dayCompleteness, goodAvg, hasDayData, hourIntegral, meanOrNull, nameplateNumber, round, roundOrNull, type LedgerContext } from './hourly';
import type { LedgerParams } from './params';
import type { H2Ledger, H2ProducedMethod, SiteEnergyDq } from './types';

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

function produced(ctx: LedgerContext, params: LedgerParams): Produced {
  if (hasDayData(ctx, 'h2.elz', 'h2.flow.mass')) {
    return { kg: sumHours(ctx, 'h2.elz', 'h2.flow.mass', (v) => Math.max(0, v)), method: 'meter', completeness: dayCompleteness(ctx, 'h2.elz', 'h2.flow.mass') };
  }
  const kg = faradayKg(ctx, params.faradayEfficiency);
  return kg === null ? { kg: null, method: null, completeness: null } : { kg, method: 'faraday_estimate', completeness: dayCompleteness(ctx, 'h2.elz.stack', 'stack.current') };
}

/** 저장용기별 끝·시작 질량 차의 합. 용기가 없거나 한 용기라도 P·T 경계값·내용적이 없으면 null */
export function storedDeltaKg(ctx: LedgerContext): number | null {
  const tanks = assetsOf(ctx, 'h2.storage.tank');
  if (tanks.length === 0) return null;
  const deltas = tanks.map((tank) => {
    const volumeL = nameplateNumber(tank, 'water_volume_l');
    const p = dayBoundary(ctx, tank.id, 'tank.pressure');
    const t = dayBoundary(ctx, tank.id, 'tank.temp');
    if (volumeL === null || p.start === null || p.end === null || t.start === null || t.end === null) return null;
    const volumeM3 = volumeL / 1000;
    return h2MassKg(p.end, t.end, volumeM3) - h2MassKg(p.start, t.start, volumeM3);
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

/** 하루 수소 원장. 수소 설비가 없는 사이트는 모든 값이 null */
export function hydrogenLedger(ctx: LedgerContext, params: LedgerParams): HydrogenDay {
  const made = produced(ctx, params);
  const fcMeasured = hasDayData(ctx, 'fc.plant', 'fc.h2.consumption');
  const fcConsumed = fcMeasured ? sumHours(ctx, 'fc.plant', 'fc.h2.consumption', (v) => Math.max(0, v)) : null;
  const stored = storedDeltaKg(ctx);
  const purges = purgeCount(ctx);
  const ventedEstimated = params.kgPerPurge > 0 || params.dryerLossFraction > 0;
  const vented = (purges ?? 0) * params.kgPerPurge + params.dryerLossFraction * (made.kg ?? 0);
  const residual = made.kg === null || fcConsumed === null || stored === null ? null : made.kg - fcConsumed - stored - vented;
  const denominator = Math.max(made.kg ?? 0, fcConsumed ?? 0, params.residualFloorKg);
  const hasHydrogen = assetsOf(ctx, 'h2.elz').length > 0 || assetsOf(ctx, 'fc.plant').length > 0;

  return {
    ledger: {
      produced: roundOrNull(made.kg, 4),
      fc_consumed: roundOrNull(fcConsumed, 4),
      stored_delta: roundOrNull(stored, 4),
      vented_est: hasHydrogen ? round(vented, 4) : null,
      residual: roundOrNull(residual, 4),
      residual_pct: residual === null ? null : round((residual / denominator) * 100, 3),
      method: {
        produced: made.method,
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
          fcMeasured ? dayCompleteness(ctx, 'fc.plant', 'fc.h2.consumption') : null,
          dayCompleteness(ctx, 'h2.storage.tank', 'tank.pressure'),
          dayCompleteness(ctx, 'h2.storage.tank', 'tank.temp'),
        ]),
        4,
      ),
      purge_count_missing: params.kgPerPurge > 0 && purges === null,
    },
  };
}
