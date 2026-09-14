// 에피소드·탐지기 테스트용 합성 원시 시계열 (결정적).
import type { Sample } from '../types';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../types';

export type MutableSeries = Record<string, Sample[]>;

export const T0 = Date.UTC(2026, 5, 1, 15); // 2026-06-02 00:00 KST

const push = (series: MutableSeries, metric: string, ts: number, value: number | null, quality = 0): void => {
  (series[metric] ??= []).push({ ts, value, quality });
};

/** 여러 시계열 맵을 메트릭별로 이어 붙이고 ts 정렬 */
export function mergeSeries(...maps: readonly MutableSeries[]): MutableSeries {
  const merged: MutableSeries = {};
  for (const map of maps) for (const [metric, samples] of Object.entries(map)) merged[metric] = [...(merged[metric] ?? []), ...samples];
  for (const metric of Object.keys(merged)) merged[metric] = [...(merged[metric] ?? [])].sort((a, b) => a.ts - b.ts);
  return merged;
}

export interface ChargeCycleOptions {
  readonly start: number;
  readonly restBeforeMin: number;
  readonly chargeA: number;
  readonly ccHours: number;
  readonly taperMin: number;
  readonly restAfterMin: number;
  readonly socStartPct: number;
  readonly tempC?: number;
  readonly cellDvMv?: number;
  /** 이 인덱스 범위(분)의 전류 샘플을 빼서 공백을 만든다 */
  readonly gapMinutes?: readonly [from: number, to: number];
  /** 이 비율의 샘플에 SPIKE 품질 비트 */
  readonly badEvery?: number;
}

/** 휴지 → CC 충전 → 테이퍼 → 휴지. 1분 주기, SOC는 충전 끝에서 100% */
export function essChargeCycle(options: ChargeCycleOptions): MutableSeries {
  const ccMin = Math.round(options.ccHours * 60);
  const currents = [
    ...Array.from({ length: options.restBeforeMin }, () => 0),
    ...Array.from({ length: ccMin }, () => options.chargeA),
    ...Array.from({ length: options.taperMin }, (_, k) => options.chargeA - ((options.chargeA - 9) * k) / Math.max(1, options.taperMin - 1)),
    ...Array.from({ length: options.restAfterMin }, () => 0),
  ];
  const totalAh = currents.reduce((sum, i) => sum + i / 60, 0);
  const series: MutableSeries = {};
  const dv = (options.cellDvMv ?? 5) / 1000;
  let cumulativeAh = 0;
  currents.forEach((current, minute) => {
    const ts = options.start + minute * MS_PER_MINUTE;
    const soc = options.socStartPct + (cumulativeAh / totalAh) * (100 - options.socStartPct);
    cumulativeAh += current / 60;
    const inGap = options.gapMinutes !== undefined && minute >= options.gapMinutes[0] && minute < options.gapMinutes[1];
    const quality = options.badEvery !== undefined && minute % options.badEvery === 0 ? 4 : 0;
    const cell = 3.25 + soc / 1000;
    if (!inGap) push(series, 'batt.current', ts, current, quality);
    push(series, 'batt.voltage', ts, cell * 260, quality);
    push(series, 'batt.soc', ts, soc, quality);
    push(series, 'cell.temp.avg', ts, options.tempC ?? 25);
    push(series, 'cell.voltage.max', ts, cell + dv / 2);
    push(series, 'cell.voltage.min', ts, cell - dv / 2);
  });
  return series;
}

/** 방전 구간: 휴지 → 일정 전류 방전 → 휴지 */
export function essDischarge(start: number, currentA: number, minutes: number): MutableSeries {
  const series: MutableSeries = {};
  const total = minutes + 20;
  for (let minute = 0; minute < total; minute += 1) {
    const ts = start + minute * MS_PER_MINUTE;
    const current = minute >= 10 && minute < 10 + minutes ? -currentA : 0;
    push(series, 'batt.current', ts, current);
    push(series, 'batt.voltage', ts, 830);
    push(series, 'batt.soc', ts, 80 - Math.max(0, Math.min(minute - 10, minutes)) * 0.5);
    push(series, 'cell.temp.avg', ts, 24);
    push(series, 'cell.voltage.max', ts, 3.3);
    push(series, 'cell.voltage.min', ts, 3.29);
  }
  return series;
}

export interface StackProfileSegment {
  readonly minutes: number;
  readonly currentA: number;
}

/** 스택 전류 계단 프로필 (1분 주기) + 전압·온도·운전시간, 느린 메트릭 5분 주기 */
export function stackProfile(start: number, segments: readonly StackProfileSegment[], options: { cells: number; areaCm2: number; startHours: number }): MutableSeries {
  const series: MutableSeries = {};
  let minute = 0;
  let runHours = options.startHours;
  for (const segment of segments) {
    for (let k = 0; k < segment.minutes; k += 1, minute += 1) {
      const ts = start + minute * MS_PER_MINUTE;
      const j = segment.currentA / options.areaCm2;
      const running = segment.currentA > 0;
      push(series, 'stack.current', ts, segment.currentA);
      push(series, 'stack.voltage', ts, running ? options.cells * (1.6 + 0.2 * j) : 0);
      push(series, 'stack.temp', ts, running ? 62 : 30);
      if (running) runHours += 1 / 60;
      if (minute % 5 === 0) {
        push(series, 'run.hours', ts, runHours);
        push(series, 'h2.flow.mass', ts, running ? 9 : 0);
        push(series, 'ac.power', ts, running ? 450 : 2);
        push(series, 'fc.h2.consumption', ts, running ? 12 : 0);
        push(series, 'fc.ac.power', ts, running ? 200 : 0);
        push(series, 'blower.power', ts, running ? 6 : 0);
        push(series, 'start.count', ts, 10);
      }
    }
  }
  return series;
}

export const hours = (h: number): number => h * MS_PER_HOUR;
