// 권고 조치 폼의 기대 효과 기본 선택: 탐지기 → 조치 효과 검증 지표·방향·안정화 일수. 순수 모듈.
// 최소 변화량은 현장 판단이라 채우지 않고, 현재 수준만 참고로 보여 준다 (가짜 수치 방지).
import { EPISODE_KINDS, isExtractable } from '@/lib/analytics/pipeline/sources';
import { VERIFICATION_METRICS } from '@/lib/analytics/verification/before-after';
import { formatNumber } from '@/lib/format';
import type { EffectView } from './effect';

export interface ExpectedEffectDefaults {
  readonly metric: string;
  readonly direction: 'increase' | 'decrease';
  readonly stabilizationDays: number;
  /** '기준 586.5 Ah → 최근 543.1 Ah' */
  readonly levelHint: string | null;
}

interface Rule {
  readonly metric: string;
  readonly stabilizationDays: number;
  /** effect 수준 단위 → 검증 지표 단위 배율 (mV → V는 0.001) */
  readonly scale: number;
  readonly unit: string;
  readonly digits: number;
}

/** 방향은 검증 지표의 좋아지는 방향(VERIFICATION_METRICS[metric].better)을 쓴다. 인버터 열 저감·물질수지·저장용기 누설·오염(발전소 설비)은 에피소드 검증 지표가 없어 기대 효과 없이 기록 */
const RULES: Readonly<Record<string, Rule>> = {
  'ess.capacity_fade': { metric: 'ess.capacity_ah', stabilizationDays: 7, scale: 1, unit: 'Ah', digits: 1 },
  'ess.cell_imbalance': { metric: 'ess.cell_dv_mv', stabilizationDays: 3, scale: 1, unit: 'mV', digits: 1 },
  'el.voltage_rise': { metric: 'el.v_cell_v', stabilizationDays: 7, scale: 0.001, unit: 'V', digits: 4 },
  'fc.voltage_decay': { metric: 'fc.v_cell_v', stabilizationDays: 7, scale: 0.001, unit: 'V', digits: 4 },
  'el.sec_rise': { metric: 'el.sec_kwh_per_kg', stabilizationDays: 7, scale: 1, unit: 'kWh/kg', digits: 2 },
  'comp.sec_rise': { metric: 'comp.sec_kwh_per_kg', stabilizationDays: 3, scale: 1, unit: 'kWh/kg', digits: 3 },
  'fc.blower_wear': { metric: 'fc.blower_specific_power', stabilizationDays: 3, scale: 1, unit: 'W/(kg/h)', digits: 2 },
  'ess.resistance_growth': { metric: 'ess.resistance_mohm', stabilizationDays: 3, scale: 1, unit: 'mΩ', digits: 1 },
};

export interface VerificationMetricOption {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
}

/** 설비 종류가 만드는 에피소드로 계산할 수 있는 조치 효과 검증 지표만 (예: ESS 랙 → ess.*, 인버터 → 없음) */
export function verificationMetricsFor(classKey: string | null): VerificationMetricOption[] {
  if (classKey === null || !isExtractable(classKey)) return [];
  const kinds: readonly string[] = EPISODE_KINDS[classKey];
  return Object.entries(VERIFICATION_METRICS)
    .filter(([, spec]) => kinds.includes(spec.kind))
    .map(([key, spec]) => ({ key, label: spec.label, unit: spec.unit }));
}

/** 검증 지표가 없는 탐지기(인버터 동종 비교·데이터 품질)는 null → 기대 효과 없이 기록 */
export function expectedEffectDefaults(detectorId: string, effect: Pick<EffectView, 'baseline' | 'current'>): ExpectedEffectDefaults | null {
  const rule = RULES[detectorId];
  if (!rule) return null;
  const level = (value: number | null) => (value === null ? null : `${formatNumber(value * rule.scale, rule.digits)} ${rule.unit}`);
  const baseline = level(effect.baseline);
  const current = level(effect.current);
  return {
    metric: rule.metric,
    direction: VERIFICATION_METRICS[rule.metric]?.better ?? 'increase',
    stabilizationDays: rule.stabilizationDays,
    levelHint: baseline !== null && current !== null ? `기준 ${baseline} → 최근 ${current}` : null,
  };
}
