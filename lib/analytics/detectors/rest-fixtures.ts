// 휴지 앵커 방식 테스트용 합성 ESS 에피소드 (결정적): 매일 밤 휴지 → 부분 충전 → 오후 휴지 → 저녁 방전 → 밤 휴지.
// 충전·방전 SOC 변화 폭이 날마다 달라 부분 사이클만 있고 CV 종료 앵커 세션은 없다 (연계형 사이트 운전과 비슷).
import type { EssChargeEpisode, EssDischargeEpisode, EssRestEpisode } from '../episodes/ess';
import { createRng } from '@/lib/sim/rng';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { DAY0, DQ_FULL } from './test-fixtures';

export interface RestCycleOptions {
  readonly days: number;
  readonly seed: number;
  /** d일째 유효용량 [Ah] */
  readonly capacityAh: (day: number) => number;
  /** d일째 셀 온도 [°C] (기본 23) */
  readonly tempC?: (day: number) => number;
  /** d일째 충전 SOC 변화 폭 [%p] (기본 30~70 번갈아) */
  readonly spanPct?: (day: number) => number;
  /** d일째 충전 종료 SOC 상한 [%] (기본 90). 밤 휴지 SOC(20%) + 폭이 이 값을 넘지 않게 자른다 */
  readonly socMaxPct?: (day: number) => number;
  /** 휴지 끝 SOC 측정 잡음 1σ [%p] (기본 0.3) */
  readonly socNoisePct?: number;
}

export interface RestCycleEpisodes {
  readonly charges: readonly EssChargeEpisode[];
  readonly discharges: readonly EssDischargeEpisode[];
  readonly rests: readonly EssRestEpisode[];
}

const BASE = { assetId: 7, dq: DQ_FULL, open: false, valid: true, invalidReason: null } as const;
const NIGHT_SOC = 20;

function rest(start: number, end: number, socEnd: number, tCell: number): EssRestEpisode {
  return {
    ...BASE,
    kind: 'ess.rest',
    extractorVersion: 'ess.rest@2',
    start,
    end,
    features: { duration_s: (end - start) / 1000, soc_mean: socEnd, soc_end: socEnd, ah_net: 0, t_cell_mean: tCell, cell_dv_end: 6, v_end: 830 },
    conditions: { t_cell_bin: Math.floor(tCell / 5) * 5, end_reason: 'reversal' },
  };
}

function charge(start: number, end: number, ahIn: number, socStart: number, socEnd: number, tCell: number): EssChargeEpisode {
  return {
    ...BASE,
    kind: 'ess.charge',
    extractorVersion: 'ess.charge@1',
    start,
    end,
    features: {
      ah_in: ahIn,
      wh_in: null,
      i_mean_c: 0.1,
      t_cell_mean: tCell,
      soc_start: socStart,
      soc_end: socEnd,
      soc_ocv_start: socStart,
      cc_ah: ahIn,
      cv_s: 0,
      soc_cv_start: null,
      duration_s: (end - start) / 1000,
      cell_dv_end: 8,
      capacity_ah_anchored: null,
      capacity_ah_cc: null,
      capacity_ah_soc: null,
    },
    conditions: { c_rate_bin: 0.1, t_cell_bin: Math.floor(tCell / 5) * 5, anchor: false, pre_rest: true, cv_end: false, end_reason: 'rest' },
  };
}

function discharge(start: number, end: number, ahOut: number, socStart: number, socEnd: number, tCell: number): EssDischargeEpisode {
  return {
    ...BASE,
    kind: 'ess.discharge',
    extractorVersion: 'ess.discharge@1',
    start,
    end,
    features: { ah_out: ahOut, wh_out: null, i_mean_c: 0.1, t_cell_mean: tCell, soc_start: socStart, soc_end: socEnd, duration_s: (end - start) / 1000, cell_dv_end: 6 },
    conditions: { c_rate_bin: 0.1, t_cell_bin: Math.floor(tCell / 5) * 5, pre_rest: true, end_reason: 'rest' },
  };
}

/** 0일째 08시(KST 기준 DAY0 − 2h = 08:00)부터 days일 */
export function restCycleHistory(o: RestCycleOptions): RestCycleEpisodes {
  const rng = createRng(o.seed);
  const noise = (): number => (o.socNoisePct ?? 0.3) * rng.gaussian();
  const at = (day: number, hour: number): number => DAY0 - 2 * MS_PER_HOUR + day * MS_PER_DAY + hour * MS_PER_HOUR;
  const days = Array.from({ length: o.days }, (_, day) => {
    const cap = o.capacityAh(day);
    const t = o.tempC?.(day) ?? 23;
    const top = Math.min(o.socMaxPct?.(day) ?? 90, NIGHT_SOC + (o.spanPct?.(day) ?? (day % 2 === 0 ? 30 : 70)));
    const span = top - NIGHT_SOC;
    const ah = (cap * span) / 100;
    return {
      charge: charge(at(day, 0), at(day, 5), ah, NIGHT_SOC, top, t),
      restAfternoon: rest(at(day, 5), at(day, 10), top + noise(), t),
      discharge: discharge(at(day, 10), at(day, 15), ah, top, NIGHT_SOC, t),
      restNight: rest(at(day, 15), at(day, 24), NIGHT_SOC + noise(), t),
    };
  });
  const first = rest(at(0, -9), at(0, 0), NIGHT_SOC, o.tempC?.(0) ?? 23);
  return {
    charges: days.map((d) => d.charge),
    discharges: days.map((d) => d.discharge),
    rests: [first, ...days.flatMap((d) => [d.restAfternoon, d.restNight])],
  };
}
