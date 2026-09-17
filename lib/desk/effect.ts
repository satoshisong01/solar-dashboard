// finding.effect(jsonb) 읽기와 효과 크기 표기. 순수 모듈 (서버·클라이언트 공용).
import { formatNumber } from '@/lib/format';

export interface EffectView {
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly levelUnit: string | null;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * 옛 dq.completeness 발견사항은 효과 자리에 변화량이 아니라 완결성 수준(91.67%)을 넣어
 * 화면이 '+91.67%'처럼 오른 것으로 보여 줬다. 지금 탐지기는 변화량(−8.33%p)을 저장한다 —
 * 다시 분석하기 전에 저장된 행도 같은 뜻으로 읽히도록 여기서 맞춘다 (단위 '%'가 옛 형식 표시다).
 */
function fromLevelToChange(effect: EffectView): EffectView {
  if (effect.metric !== 'dq.completeness' || effect.unit !== '%' || effect.value === null || effect.baseline === null) return effect;
  return { ...effect, value: effect.value - effect.baseline, unit: '%p' };
}

/** 저장된 effect jsonb → 표시용. 모르는 값은 null */
export function parseEffect(raw: unknown): EffectView {
  const e = asRecord(raw);
  return fromLevelToChange({
    metric: str(e.metric) ?? '',
    value: num(e.value),
    unit: str(e.unit) ?? '',
    ciLow: num(e.ciLow),
    ciHigh: num(e.ciHigh),
    baseline: num(e.baseline),
    current: num(e.current),
    levelUnit: str(e.levelUnit),
  });
}

/** 부호 붙은 수: +1.2 / −6.3 (마이너스 기호 U+2212) */
export function formatSigned(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  const text = formatNumber(Math.abs(rounded), digits);
  if (rounded > 0) return `+${text}`;
  return rounded < 0 ? `−${text}` : text;
}

const withUnit = (text: string, unit: string): string => (unit === '' ? text : unit === '%' || unit === '%p' ? `${text}${unit}` : `${text} ${unit}`);

/** '−7.4%' · '+21.4 µV/h' */
export function formatEffectValue(effect: Pick<EffectView, 'value' | 'unit'>, digits = 1): string {
  return withUnit(formatSigned(effect.value, digits), effect.unit);
}

/** '95% CI −7.5 ~ −7.2' (CI가 없으면 null) */
export function formatEffectCi(effect: Pick<EffectView, 'ciLow' | 'ciHigh'>, digits = 1): string | null {
  if (effect.ciLow === null || effect.ciHigh === null) return null;
  return `95% CI ${formatSigned(effect.ciLow, digits)} ~ ${formatSigned(effect.ciHigh, digits)}`;
}

/** 효과·CI 표시 자릿수 상한 */
export const MAX_EFFECT_DIGITS = 3;

/**
 * 점추정과 CI 경계가 표시상 같아지지 않는 자릿수: digits부터 시작해 값이 CI 하한·상한 중 하나와 같은 글자로 보이면
 * 자릿수를 하나씩 늘린다 (최대 MAX_EFFECT_DIGITS). 실제 값이 같으면 늘려도 같으므로 상한에서 멈춘다.
 * format은 표시 방식(부호 붙은 수 또는 보통 수) — 리포트 토큰(signed·number)과 같은 표기로 비교해야 한다.
 */
export function effectCiDigits(effect: Pick<EffectView, 'value' | 'ciLow' | 'ciHigh'>, digits = 1, format: (value: number, digits: number) => string = formatSigned): number {
  const { value, ciLow, ciHigh } = effect;
  if (value === null || !Number.isFinite(value)) return digits;
  const collides = (d: number): boolean => [ciLow, ciHigh].some((bound) => bound !== null && Number.isFinite(bound) && format(bound, d) === format(value, d));
  let chosen = digits; // 자릿수를 늘려 가며 찾는 값
  while (collides(chosen) && chosen < MAX_EFFECT_DIGITS) chosen += 1;
  return chosen;
}

export interface EffectWithCiText {
  /** '−7.40%' */
  readonly value: string;
  /** '95% CI −7.43 ~ −7.38' (CI가 없으면 null) */
  readonly ci: string | null;
  readonly digits: number;
}

/** 효과 크기와 95% CI를 서로 구분되는 같은 자릿수로 표기한다 (분석 데스크·리포트 공용 규칙) */
export function formatEffectWithCi(effect: Pick<EffectView, 'value' | 'unit' | 'ciLow' | 'ciHigh'>, digits = 1): EffectWithCiText {
  const chosen = effectCiDigits(effect, digits);
  return { value: formatEffectValue(effect, chosen), ci: formatEffectCi(effect, chosen), digits: chosen };
}

/** '586.5 Ah → 543.1 Ah' (둘 다 있을 때만) */
export function formatEffectLevels(effect: Pick<EffectView, 'baseline' | 'current' | 'levelUnit'>, digits = 1): string | null {
  if (effect.baseline === null || effect.current === null) return null;
  const unit = effect.levelUnit ?? '';
  return `${withUnit(formatNumber(effect.baseline, digits), unit)} → ${withUnit(formatNumber(effect.current, digits), unit)}`;
}
