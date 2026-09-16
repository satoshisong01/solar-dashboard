// 가평 구성 탐지기 3종의 합성 입력 (테스트 전용). 값의 크기는 조사 문서의 임계와 같은 단위로 맞췄다.
import type { HtoDay, HxSample, PrvHold } from '../episodes/gapyeong-samples';
import { createRng } from '@/lib/sim/rng';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR } from '../types';

/** 2026-06-01 KST 0시 */
export const GP_DAY0 = kstDayStart(Date.UTC(2026, 5, 1, 3));

export interface PrvHoldOptions {
  readonly seed: number;
  /** hold 개수 (하루 하나) */
  readonly holds: number;
  /** 날짜별 크리프율 [bar/h] */
  readonly creepBarPerH: (day: number) => number;
  /** hold 한 개 길이 [시간] */
  readonly hours?: number;
  /** 하류 압력 잡음 σ [bar] */
  readonly noiseBar?: number;
  /** 공급압 효과: 버퍼가 hold 동안 떨어지면서 설정압이 따라 오르는 정도 [bar/bar]. 0이면 버퍼는 정지 중 그대로다 */
  readonly supplyCoupling?: number;
}

/** 무유동 hold 구간 (하루 1개, 야간 정지 구간을 흉내낸다) */
export function prvHoldsFixture(o: PrvHoldOptions): PrvHold[] {
  const rng = createRng(o.seed);
  const hours = o.hours ?? 8;
  const noise = o.noiseBar ?? 0.002;
  return Array.from({ length: o.holds }, (_, day) => {
    const start = GP_DAY0 + day * MS_PER_DAY + 22 * MS_PER_HOUR;
    const base = 0.88;
    const creep = o.creepBarPerH(day);
    return {
      start,
      end: start + hours * MS_PER_HOUR,
      hours: Array.from({ length: hours }, (_, h) => {
        // 정지 중 버퍼는 그대로다. 공급압 효과를 넣으면 버퍼가 떨어지고(1.2 bar/h) 그만큼 하류 설정압이 오른다 (EN 334 SG 등급)
        const drop = (o.supplyCoupling ?? 0) > 0 ? 1.2 * h : 0;
        const inletBar = 18 - drop;
        return {
          hourStart: start + h * MS_PER_HOUR,
          outletBar: base + creep * h + (o.supplyCoupling ?? 0) * drop + noise * rng.gaussian(),
          inletBar,
          ambientC: 18 - 0.3 * h,
          setpointBar: 0.8,
        };
      }),
    };
  });
}

export interface HxSampleOptions {
  readonly seed: number;
  readonly days: number;
  /** 날짜별 UA 저하 비율 0~1 */
  readonly fouling: (day: number) => number;
  /** 하루 표본 시간 수 */
  readonly hoursPerDay?: number;
  readonly designUaKwK?: number;
  /** 2차측 유량 [m³/h] */
  readonly coldFlowM3H?: number;
  /** 날짜별 1차측 차압 배율 (스케일 판별 체크) */
  readonly diffFactor?: (day: number) => number;
}

const CP_WATER = 4.186;

/** 정상상태 표본: 1차측 75 °C, 2차측 입구 15 °C, ε-NTU로 2차측 출구를 만든다 */
export function hxSamplesFixture(o: HxSampleOptions): HxSample[] {
  const rng = createRng(o.seed);
  const hoursPerDay = o.hoursPerDay ?? 5;
  const ua = o.designUaKwK ?? 0.76;
  const coldFlow = o.coldFlowM3H ?? 0.5;
  const cCold = ((coldFlow * 1000) / 3_600) * CP_WATER;
  return Array.from({ length: o.days }, (_, day) =>
    Array.from({ length: hoursPerDay }, (_, h) => {
      const hourStart = GP_DAY0 + day * MS_PER_DAY + (17 + h) * MS_PER_HOUR;
      const hotInC = 75 + 0.4 * rng.gaussian();
      const coldInC = 15 + 0.3 * rng.gaussian();
      const effectiveness = 1 - Math.exp(-(ua * (1 - o.fouling(day))) / cCold);
      const coldOutC = coldInC + effectiveness * (hotInC - coldInC) + 0.05 * rng.gaussian();
      const heatKw = cCold * (coldOutC - coldInC);
      return {
        hourStart,
        hotInC,
        hotOutC: hotInC - heatKw / 23.3,
        coldInC,
        coldOutC,
        coldFlowM3H: coldFlow,
        hotFlowM3H: 20,
        heatKw,
        diffHotKpa: 45 * (o.diffFactor?.(day) ?? 1),
      };
    }),
  ).flat();
}

export interface HtoDayOptions {
  readonly seed: number;
  readonly days: number;
  /** 날짜별 HTO 중앙값 [vol%] */
  readonly htoPct: (day: number) => number;
  /** 날짜별 부하율 (부분부하 판별 체크) */
  readonly load?: (day: number) => number;
  readonly hours?: number;
}

export function htoDaysFixture(o: HtoDayOptions): HtoDay[] {
  const rng = createRng(o.seed);
  return Array.from({ length: o.days }, (_, day) => {
    const medianPct = Math.max(0, o.htoPct(day) + 0.02 * rng.gaussian());
    return { day: GP_DAY0 + day * MS_PER_DAY, medianPct, maxPct: medianPct * 1.25, hours: o.hours ?? 5, loadFraction: o.load?.(day) ?? 0.7 };
  });
}
