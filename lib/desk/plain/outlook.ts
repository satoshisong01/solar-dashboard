// 3) 왜 문제인지 · 언제까지 괜찮은지 — 추세로 시점을 말할 수 있으면 시점, 아니면 영향 크기.
// 시점은 근거에 이미 들어 있는 외삽 가드(lib/desk/projection.ts) 결과만 쓴다. 가드를 통과하지 못한 추세로 날짜를 지어내지 않는다.
import { formatKstDate, formatNumber } from '@/lib/format';
import { convertedChargeTime, formatHoursMinutes } from '../conditions';
import type { EffectView } from '../effect';
import type { CapacityEvidence, CellImbalanceEvidence, DqEvidence, EvidenceView, PvPeerEvidence } from '../evidence-types';
import type { MassBalanceEvidence, RiseEvidence, SoilingEvidence, TankLeakEvidence, ThermalEvidence } from '../p3-evidence-types';
import { cleaningEconomics } from '../p3-view';
import { RISE_META } from '../rise-meta';
import { amount, LEAK_DIGITS, size } from './common';
import type { PlainFinding } from './types';

/** 안전 판단을 사람에게 되돌리는 고정 문구. 문장을 다시 쓸 때도 그대로 남아야 한다 (lib/llm/validate.ts) */
export const SAFETY_DECISION_NOTICE = '운전을 멈출지는 현장 안전책임자가 판단합니다.';

const sum = (values: readonly (number | null)[]): number => values.reduce((total: number, value) => total + (value ?? 0), 0);

function capacityOutlook(e: CapacityEvidence, effect: EffectView): string {
  const charge = convertedChargeTime(effect.baseline, effect.current, e.referenceCurrentA);
  const impact = charge === null ? '한 번에 담아 둘 수 있는 전기가 그만큼 줄었습니다.' : `같은 전류로 가득 채우는 시간이 ${formatHoursMinutes(charge.baselineHours)}에서 ${formatHoursMinutes(charge.currentHours)}로 짧아졌습니다.`;
  const target = e.sohTarget;
  if (target === null || target.projection === null) return impact;
  if (target.projection.kind === 'date') return `${impact} 이 속도라면 ${formatKstDate(target.projection.estimate)}쯤 새것일 때 용량의 ${target.pct}%까지 떨어집니다.`;
  return `${impact} 언제 새것일 때 용량의 ${target.pct}%까지 떨어질지는 데이터가 ${target.projection.spanDays}일치뿐이라 아직 말하기 이릅니다.`;
}

const STACK_OUTLOOKS: Readonly<Record<string, string>> = {
  'el.voltage_rise': '전압이 오를수록 같은 양의 수소를 만드는 데 전기를 더 쓰고, 스택을 바꿔야 하는 시점도 앞당겨집니다.',
  'fc.voltage_decay': '전압이 떨어질수록 같은 전기를 내려고 수소를 더 씁니다.',
};

function cellImbalanceOutlook(e: CellImbalanceEvidence): string {
  const peer = e.peers.modifiedZ === null || e.peers.values.length === 0 ? '' : ` 같은 사이트의 다른 랙들과 견줘도 이 랙만 유독 큽니다.`;
  return `셀마다 전압이 벌어지면 가장 약한 셀 때문에 충전이 일찍 끝나, 실제로 쓸 수 있는 용량이 줄어듭니다.${peer}`;
}

function pvPeerOutlook(e: PvPeerEvidence, effect: EffectView): string {
  const level = effect.baseline === null || effect.current === null ? '' : ` 같은 날 옆 인버터들이 1 kW당 ${formatNumber(effect.baseline, 2)} kWh를 만들 때 이 인버터는 ${formatNumber(effect.current, 2)} kWh를 만들었습니다.`;
  return `같은 햇빛을 받고도 덜 만드는 만큼 매일 발전 수익이 빠집니다.${level} 낮게 나온 날이 ${e.days.filter((day) => day.flagged).length}일입니다.`;
}

function dqOutlook(e: DqEvidence): string {
  const longest = Math.max(0, ...e.points.map((point) => point.gapHours ?? 0));
  const gap = longest > 0 ? ` 가장 길게 끊긴 구간은 ${formatNumber(longest, 1)}시간입니다.` : '';
  return `데이터가 빠진 동안은 다른 분석도 판정을 미루기 때문에, 고장을 늦게 찾게 됩니다.${gap}`;
}

const RISE_OUTLOOKS: Readonly<Record<RiseEvidence['detectorId'], string>> = {
  'el.sec_rise': '전기를 더 쓰는 만큼 수소 1 kg을 만드는 원가가 올라갑니다.',
  'comp.sec_rise': '압축에 전기를 더 쓰는 만큼 같은 양을 채우는 비용이 올라갑니다.',
  'fc.blower_wear': '블로워가 더 힘들게 돌고 있다는 뜻이라, 공기 필터가 막혔거나 베어링이 닳았을 수 있습니다.',
  'ess.resistance_growth': '저항이 커지면 충전·방전할 때 열이 더 나고, 실제로 쓸 수 있는 용량도 줄어듭니다.',
};

function riseLevel(e: RiseEvidence, effect: EffectView): string {
  if (effect.baseline === null || effect.current === null) return '';
  const digits = RISE_META[e.detectorId].levelDigits;
  const before = formatNumber(effect.baseline, digits);
  const after = formatNumber(effect.current, digits);
  switch (e.detectorId) {
    case 'el.sec_rise':
      return `수소 1 kg에 ${before} kWh를 쓰던 것이 지금은 ${after} kWh입니다. `;
    case 'comp.sec_rise':
      return `수소 1 kg을 압축하는 데 ${before} kWh를 쓰던 것이 지금은 ${after} kWh입니다. `;
    case 'fc.blower_wear':
      return `공기를 시간당 1 kg 보내는 데 ${before} W를 쓰던 것이 지금은 ${after} W입니다. `;
    case 'ess.resistance_growth':
      return `저항이 ${before} mΩ에서 ${after} mΩ이 됐습니다. `;
  }
}

function tankLeakOutlook(e: TankLeakEvidence): string {
  const daily = e.pctPerDay === null ? '' : ` 세워 둔 저장량의 하루 ${size(e.pctPerDay, 2)}%에 해당합니다.`;
  if (e.safetyCategory && e.safetyKgPerDay !== null) {
    return `줄어드는 양이 안전 기준 하루 ${size(e.safetyKgPerDay, LEAK_DIGITS)} kg을 넘어, 안전 확인이 먼저인 건입니다.${daily} ${SAFETY_DECISION_NOTICE}`;
  }
  const noise = e.thresholdKgPerDay === null ? '' : ` 센서 흔들림으로 설명되는 크기(하루 ${size(e.thresholdKgPerDay, LEAK_DIGITS)} kg)보다 큽니다.`;
  return `아직 미세 누설 의심 단계입니다.${noise}${daily}`;
}

function massBalanceOutlook(e: MassBalanceEvidence): string {
  const kg = e.recent.medianKg === null ? '' : `하루 약 ${size(e.recent.medianKg, 2)} kg이 `;
  const alarm = e.cusum.alarmDay === null ? '' : ` 어긋나기 시작한 날은 ${e.cusum.alarmDay}입니다.`;
  return `${kg}계량으로 설명되지 않습니다. 계량기가 틀렸거나, 어딘가로 새고 있다는 뜻입니다.${alarm}`;
}

function soilingOutlook(e: SoilingEvidence): string {
  const economics = cleaningEconomics(e);
  const lost = e.economics.cumulativeLossKwh === null ? '' : `지금까지 못 만든 전기가 약 ${amount(e.economics.cumulativeLossKwh)} kWh입니다. `;
  if (economics.verdict === 'no_price') return `${lost}전기 판매 가격을 넣지 않아 세척이 이득인지는 계산하지 않았습니다.`;
  const share = economics.shareOfCleaningPct === null ? '' : ` 세척 한 번 비용의 ${amount(economics.shareOfCleaningPct)}%입니다.`;
  const verdict = economics.verdict === 'clean' ? ' 손실이 세척비를 넘었으니 세척을 검토하세요.' : ' 아직 세척비보다는 적습니다.';
  return `${lost}손실을 돈으로 치면 약 ${amount(economics.lossValueKrw)}원입니다.${share}${verdict}`;
}

function thermalOutlook(e: ThermalEvidence): string {
  const lossKwh = sum(e.days.map((day) => day.lossKwh));
  const derateH = sum(e.days.map((day) => day.derateH));
  const shift = e.binShift === null ? '' : ` 기온이 같은 날끼리 견주면 하루 ${formatNumber(e.binShift.ref, 2)}시간이던 것이 ${formatNumber(e.binShift.cur, 2)}시간으로 늘었습니다.`;
  return `최근 ${e.days.length}일 동안 ${formatNumber(derateH, 1)}시간을 줄여 돌면서 약 ${amount(lossKwh)} kWh를 못 만들었습니다.${shift}`;
}

/** 근거로 말할 수 있는 게 없으면 null */
export function plainOutlook(finding: PlainFinding, evidence: EvidenceView): string | null {
  switch (evidence.kind) {
    case 'capacity':
      return capacityOutlook(evidence, finding.effect);
    case 'stack':
      return STACK_OUTLOOKS[finding.detectorId] ?? null;
    case 'cell_imbalance':
      return cellImbalanceOutlook(evidence);
    case 'pv_peer':
      return pvPeerOutlook(evidence, finding.effect);
    case 'dq':
      return dqOutlook(evidence);
    case 'rise':
      return `${riseLevel(evidence, finding.effect)}${RISE_OUTLOOKS[evidence.detectorId]}`;
    case 'tank_leak':
      return tankLeakOutlook(evidence);
    case 'mass_balance':
      return massBalanceOutlook(evidence);
    case 'soiling':
      return soilingOutlook(evidence);
    case 'thermal':
      return thermalOutlook(evidence);
    default:
      return null;
  }
}
