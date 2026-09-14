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

/** 저장된 effect jsonb → 표시용. 모르는 값은 null */
export function parseEffect(raw: unknown): EffectView {
  const e = asRecord(raw);
  return {
    metric: str(e.metric) ?? '',
    value: num(e.value),
    unit: str(e.unit) ?? '',
    ciLow: num(e.ciLow),
    ciHigh: num(e.ciHigh),
    baseline: num(e.baseline),
    current: num(e.current),
    levelUnit: str(e.levelUnit),
  };
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

/** '586.5 Ah → 543.1 Ah' (둘 다 있을 때만) */
export function formatEffectLevels(effect: Pick<EffectView, 'baseline' | 'current' | 'levelUnit'>, digits = 1): string | null {
  if (effect.baseline === null || effect.current === null) return null;
  const unit = effect.levelUnit ?? '';
  return `${withUnit(formatNumber(effect.baseline, digits), unit)} → ${withUnit(formatNumber(effect.current, digits), unit)}`;
}
