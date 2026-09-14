// 같은 조건 비교 문장·bin 표기·기준 전류 환산 충전시간. 순수 모듈 (서버·클라이언트 공용).
// 예: "충전전류 0.20~0.25C, 셀온도 20~25°C, 휴지 후 SOC ≤ 20% 시작 → 완충, 기준 18회·최근 9회"

export type CapacityMetric = 'capacity_ah_anchored' | 'rest_anchored' | 'capacity_ah_cc' | 'capacity_ah_soc';

export const CAPACITY_METRICS: readonly CapacityMetric[] = ['capacity_ah_anchored', 'rest_anchored', 'capacity_ah_cc', 'capacity_ah_soc'];

export interface CapacityBinView {
  /** 'C-rate bin 하한|셀온도 bin 하한' 또는 휴지 앵커 '방향(chg·dis)|셀온도 bin 하한' (온도 없음은 'na') */
  readonly key: string;
  readonly nRef: number;
  readonly nCur: number;
  readonly medRef: number | null;
  readonly medCur: number | null;
  readonly ratio: number | null;
  readonly used: boolean;
  /** bin별 기준 기간 (예전 스냅샷에는 없음) */
  readonly refFrom?: number | null;
  readonly refTo?: number | null;
  /** 결합에서 뺀 이유: 'reference_spread' = 주 bin 기준 시점과 너무 떨어짐 */
  readonly excluded?: string | null;
}

export interface BinWidths {
  readonly cRate: number;
  readonly tempC: number;
}

/** 세션 선택 규칙 (에피소드 추출기·탐지기 파라미터) */
export interface SessionRules {
  readonly anchorSocMaxPct: number;
  readonly minCcSocSpanPct: number;
  readonly minSocSpanPct: number;
  /** 휴지 앵커: 휴지 최소 길이 [분]·SOC 변화 하한 [%p] */
  readonly restMinutes: number;
  readonly minDeltaSocRestPct: number;
}

interface ParsedBinKey {
  readonly cRate: number | null;
  readonly tempC: number | null;
  /** 휴지 앵커 bin의 방향 (세션 bin이면 null) */
  readonly direction: 'charge' | 'discharge' | null;
}

const DIRECTIONS: Readonly<Record<string, ParsedBinKey['direction']>> = { chg: 'charge', dis: 'discharge' };

export function parseCapacityBinKey(key: string): ParsedBinKey {
  const [c = '', t = ''] = key.split('|');
  const toNumber = (text: string): number | null => (text === '' || text === 'na' || !Number.isFinite(Number(text)) ? null : Number(text));
  return { cRate: toNumber(c), tempC: toNumber(t), direction: DIRECTIONS[c] ?? null };
}

/** 부동소수 잡음 없이 소수 자릿수 고정 */
const fixed = (value: number, digits: number): string => (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits);
const decimalsOf = (width: number): number => Math.min(3, Math.max(0, (String(width).split('.')[1] ?? '').length));

export function cRateRangeText(low: number, high: number, width: number): string {
  const digits = Math.max(2, decimalsOf(width));
  return `${fixed(low, digits)}~${fixed(high, digits)}C`;
}

export function tempRangeText(low: number, high: number, width: number): string {
  const digits = decimalsOf(width);
  return `${fixed(low, digits)}~${fixed(high, digits)}°C`;
}

/** bin 키 → '0.10~0.15C · 20~25°C' · '충전 방향 · 20~25°C' */
export function capacityBinLabel(key: string, widths: BinWidths): string {
  const { cRate, tempC, direction } = parseCapacityBinKey(key);
  const c = direction !== null ? `${direction === 'charge' ? '충전' : '방전'} 방향` : cRate === null ? 'C-rate 없음' : cRateRangeText(cRate, cRate + widths.cRate, widths.cRate);
  const t = tempC === null ? '셀온도 없음' : tempRangeText(tempC, tempC + widths.tempC, widths.tempC);
  return `${c} · ${t}`;
}

export function sessionRuleText(metric: CapacityMetric, rules: SessionRules): string {
  switch (metric) {
    case 'capacity_ah_anchored':
      return `휴지 후 SOC ≤ ${rules.anchorSocMaxPct}% 시작 → 완충`;
    case 'rest_anchored':
      return `${rules.restMinutes}분 이상 휴지 끝 SOC 두 점, SOC 변화 ≥ ${rules.minDeltaSocRestPct}%`;
    case 'capacity_ah_cc':
      return `휴지 후 시작, 상한 전 CC 구간 SOC 변화 ≥ ${rules.minCcSocSpanPct}%`;
    case 'capacity_ah_soc':
      return `SOC 변화 ≥ ${rules.minSocSpanPct}%·휴지로 끝난 부분 충전`;
  }
}

const rangeOf = (values: readonly number[]): { low: number; high: number } | null => (values.length === 0 ? null : { low: Math.min(...values), high: Math.max(...values) });

/** 비교에 쓴 bin(used)으로 같은 조건 문장을 만든다. 쓴 bin이 없으면 null */
export function capacityConditionSentence(input: { metric: CapacityMetric; bins: readonly CapacityBinView[]; widths: BinWidths; rules: SessionRules }): string | null {
  const used = input.bins.filter((bin) => bin.used);
  if (used.length === 0) return null;
  const parsed = used.map((bin) => parseCapacityBinKey(bin.key));
  const cRates = rangeOf(parsed.flatMap((p) => (p.cRate === null ? [] : [p.cRate])));
  const temps = rangeOf(parsed.flatMap((p) => (p.tempC === null ? [] : [p.tempC])));
  const nRef = used.reduce((sum, bin) => sum + bin.nRef, 0);
  const nCur = used.reduce((sum, bin) => sum + bin.nCur, 0);
  return [
    cRates ? `충전전류 ${cRateRangeText(cRates.low, cRates.high + input.widths.cRate, input.widths.cRate)}` : null,
    temps ? `셀온도 ${tempRangeText(temps.low, temps.high + input.widths.tempC, input.widths.tempC)}` : null,
    sessionRuleText(input.metric, input.rules),
    input.metric === 'rest_anchored' ? `기준 ${nRef}쌍·최근 ${nCur}쌍` : `기준 ${nRef}회·최근 ${nCur}회`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/** 시간 → '8h 00m' */
export function formatHoursMinutes(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

export interface ChargeTimeComparison {
  readonly referenceCurrentA: number;
  readonly baselineHours: number;
  readonly currentHours: number;
  /** 최근 − 기준 [분] */
  readonly deltaMinutes: number;
}

/** 유효용량 [Ah]을 기준 전류 [A]로 나눈 환산 충전시간 (0 → 100%). 전류가 0 이하이거나 값이 없으면 null */
export function convertedChargeTime(baselineAh: number | null, currentAh: number | null, referenceCurrentA: number | null): ChargeTimeComparison | null {
  if (baselineAh === null || currentAh === null || referenceCurrentA === null) return null;
  if (!(referenceCurrentA > 0) || !Number.isFinite(baselineAh) || !Number.isFinite(currentAh)) return null;
  const baselineHours = baselineAh / referenceCurrentA;
  const currentHours = currentAh / referenceCurrentA;
  return { referenceCurrentA, baselineHours, currentHours, deltaMinutes: Math.round((currentHours - baselineHours) * 60) };
}

/** '50 A 기준 8h 00m → 7h 30m' */
export function chargeTimeText(comparison: ChargeTimeComparison): string {
  const current = Math.round(comparison.referenceCurrentA * 10) / 10;
  return `${current} A 기준 ${formatHoursMinutes(comparison.baselineHours)} → ${formatHoursMinutes(comparison.currentHours)}`;
}
