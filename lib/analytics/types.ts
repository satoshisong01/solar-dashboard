// lib/analytics 공용 타입과 상수. DB·I/O 없는 순수 모듈이다 ('server-only' 금지).
import type { Rng } from '@/lib/sim/rng';

/** jsonb에 그대로 넣을 수 있는 값 (features·conditions·evidence) */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

/** 판단 로직에 주입하는 난수원. lib/sim/rng의 Rng와 호환된다 (Math.random 금지). */
export type RandomSource = Pick<Rng, 'next'>;

/** [start, end) epoch ms */
export interface TimeWindow {
  readonly start: number;
  readonly end: number;
}

/** 원시 샘플 한 개 (om.measurement 한 행). value null = 결측 */
export interface Sample {
  readonly ts: number;
  readonly value: number | null;
  readonly quality: number;
}

/** 한 설비의 메트릭 키별 원시 샘플. 각 배열은 ts 오름차순이어야 한다 (series.ts의 sortSamples로 맞춘다). */
export type AssetSeries = Readonly<Record<string, readonly Sample[] | undefined>>;

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
/** 가상·실제 사이트 모두 Asia/Seoul (UTC+9, 서머타임 없음). 일 경계는 KST다 (설계 §5.2). */
export const KST_OFFSET_MS = 9 * MS_PER_HOUR;
/** 평균 한 달 [일] — %/월 환산용 */
export const DAYS_PER_MONTH = 30.44;

/** epoch ms가 속한 KST 날짜의 0시 (epoch ms) */
export const kstDayStart = (ts: number): number => Math.floor((ts + KST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - KST_OFFSET_MS;

/** epoch ms → 'YYYY-MM-DD' (KST) */
export function kstDateString(ts: number): string {
  return new Date(kstDayStart(ts) + KST_OFFSET_MS).toISOString().slice(0, 10);
}
