// 사이트 체인 원장 조회 기간 (URL 쿼리 ↔ KST 날짜 범위). 순수 모듈 (서버·클라이언트 공용).
//   chain=7|30|90   끝 = 오늘(KST) 전날(원장은 하루가 끝난 날만 저장한다), 시작 = 끝 − (N − 1)일
//   chain=custom&from=YYYY-MM-DD&to=YYYY-MM-DD   양 끝 포함. 끝이 어제보다 늦으면 어제로 줄이고, 기간은 최대 400일
//   틀린 값은 기본(최근 30일)으로 되돌린다.
import { MAX_CHAIN_DAYS } from './limits';

export const CHAIN_PRESET_DAYS = [7, 30, 90] as const;
export type ChainPresetDays = (typeof CHAIN_PRESET_DAYS)[number];
export const DEFAULT_CHAIN_DAYS: ChainPresetDays = 30;

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ChainPeriod {
  readonly kind: 'preset' | 'custom';
  /** 프리셋이면 일수, 사용자 지정이면 null */
  readonly presetDays: ChainPresetDays | null;
  /** KST 날짜 (양 끝 포함) */
  readonly fromDay: string;
  readonly toDay: string;
  readonly days: number;
  readonly label: string;
}

/** 'YYYY-MM-DD'가 실제 달력 날짜면 그 날짜의 UTC 0시 ms (날짜 산술용), 아니면 null */
export function parseDay(value: string | undefined): number | null {
  const match = value === undefined ? null : DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? ms : null;
}

const dayString = (utcMidnightMs: number): string => new Date(utcMidnightMs).toISOString().slice(0, 10);

/** nowMs가 속한 KST 날짜의 전날 (UTC 0시 ms, 날짜 산술용) */
const yesterdayOf = (nowMs: number): number => Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - DAY_MS;

/** 원장이 있을 수 있는 마지막 날 (KST 어제, 'YYYY-MM-DD') */
export const lastCompleteDay = (nowMs: number): string => dayString(yesterdayOf(nowMs));

const isPresetDays = (value: number): value is ChainPresetDays => (CHAIN_PRESET_DAYS as readonly number[]).includes(value);

function preset(days: ChainPresetDays, nowMs: number): ChainPeriod {
  const to = yesterdayOf(nowMs);
  return { kind: 'preset', presetDays: days, fromDay: dayString(to - (days - 1) * DAY_MS), toDay: dayString(to), days, label: `최근 ${days}일` };
}

export function resolveChainPeriod(params: Readonly<{ chain?: string; from?: string; to?: string }>, nowMs: number): ChainPeriod {
  if (params.chain === 'custom') {
    const from = parseDay(params.from);
    const rawTo = parseDay(params.to);
    const yesterday = yesterdayOf(nowMs);
    const to = rawTo === null ? null : Math.min(rawTo, yesterday);
    if (from !== null && to !== null && from <= to && (to - from) / DAY_MS + 1 <= MAX_CHAIN_DAYS) {
      const days = (to - from) / DAY_MS + 1;
      return { kind: 'custom', presetDays: null, fromDay: dayString(from), toDay: dayString(to), days, label: `${dayString(from)} ~ ${dayString(to)}` };
    }
  }
  const requested = Number(params.chain);
  return preset(isPresetDays(requested) ? requested : DEFAULT_CHAIN_DAYS, nowMs);
}

/** 화면 URL 쿼리 (앞의 '?' 없음) */
export function chainPeriodSearch(period: ChainPeriod): string {
  const params = new URLSearchParams();
  if (period.kind === 'preset' && period.presetDays !== null) {
    params.set('chain', String(period.presetDays));
  } else {
    params.set('chain', 'custom');
    params.set('from', period.fromDay);
    params.set('to', period.toDay);
  }
  return params.toString();
}
