// 2) 왜 믿을 만한지 — 무엇과 무엇을 같은 조건에서 견줬는지 한 문장. 근거 스냅샷(EvidenceView)의 표본 수·조건 범위를 그대로 쓴다.
import { cRateRangeText, parseCapacityBinKey, tempRangeText } from '../conditions';
import type { CapacityEvidence, CellImbalanceEvidence, DqEvidence, EvidenceView, PvPeerEvidence, StackEvidence } from '../evidence-types';
import type { MassBalanceEvidence, RiseEvidence, SoilingEvidence, TankLeakEvidence, ThermalEvidence } from '../p3-evidence-types';
import { RISE_META } from '../rise-meta';
import { amount, withParticle } from './common';

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const rangeOf = (values: readonly number[]): { low: number; high: number } | null => (values.length === 0 ? null : { low: Math.min(...values), high: Math.max(...values) });

/** '예전 20번, 최근 12번을 비교했습니다' */
const comparedCounts = (nRef: number, nCur: number, word: string): string => `예전 ${amount(nRef)}${word}, 최근 ${amount(nCur)}${withParticle(word, '을', '를')} 비교했습니다`;

function capacityBasis(e: CapacityEvidence): string {
  const used = e.bins.filter((bin) => bin.used);
  const keys = used.map((bin) => parseCapacityBinKey(bin.key));
  const cRates = rangeOf(keys.flatMap((key) => (key.cRate === null ? [] : [key.cRate])));
  const temps = rangeOf(keys.flatMap((key) => (key.tempC === null ? [] : [key.tempC])));
  const conditions = [
    cRates === null ? null : `충전 전류 ${cRateRangeText(cRates.low, cRates.high + e.widths.cRate, e.widths.cRate)}`,
    temps === null ? null : `셀 온도 ${tempRangeText(temps.low, temps.high + e.widths.tempC, e.widths.tempC)}`,
  ].filter((part): part is string => part !== null);
  const word = e.metric === 'rest_anchored' ? '쌍' : '번';
  const head = conditions.length === 0 ? '조건이 비슷했던 때끼리만 골라 ' : `${conditions.join('와 ')}처럼 조건이 비슷했던 때끼리만 골라 `;
  return `${head}${comparedCounts(sum(used.map((bin) => bin.nRef)), sum(used.map((bin) => bin.nCur)), word)}`;
}

function stackBasis(e: StackEvidence): string {
  const n = sum(e.bins.map((bin) => bin.n));
  const breakIn = e.breakInHours === null ? '' : `길들이기 ${amount(e.breakInHours)}시간을 지난 뒤의 `;
  return `전류 세기와 온도가 비슷한 구간 ${e.bins.length}개만 모아, ${breakIn}정상 운전 ${amount(n)}구간을 누적 운전시간 순서로 늘어놓고 기울기를 쟀습니다`;
}

function cellImbalanceBasis(e: CellImbalanceEvidence): string {
  const when = e.source === 'rest' ? '쉬는 동안' : '충전이 끝난 순간';
  const peers = e.peers.values.length;
  return `${when}에 잰 값으로 ${comparedCounts(e.reference.n, e.recent.n, '번')}${peers > 0 ? `. 같은 사이트의 다른 랙 ${peers}대와도 견줬습니다` : ''}`;
}

function pvPeerBasis(e: PvPeerEvidence): string {
  const peers = Math.max(0, ...e.days.map((day) => day.peers ?? 0));
  const flagged = e.days.filter((day) => day.flagged).length;
  const excluded = e.excludedDays ? `. 출력을 일부러 줄였거나 멈춘 ${e.excludedDays}일은 뺐습니다` : '';
  return `같은 사이트의 같은 인버터 ${peers}대와 날마다 견줬고, 살펴본 ${e.days.length}일 가운데 ${flagged}일이 낮았습니다${excluded}`;
}

function dqBasis(e: DqEvidence): string {
  return `계측 지점 ${e.points.length}개의 수신 기록을 봤습니다 (데이터가 끊긴 지점 ${e.gapPoints ?? 0}개, 값이 멈춘 지점 ${e.flatlinePoints ?? 0}개)`;
}

function riseBasis(e: RiseEvidence): string {
  const meta = RISE_META[e.detectorId];
  const used = e.bins.filter((bin) => bin.used);
  const conditions = `${withParticle(meta.loadName, '과', '와')} ${meta.tempName}가`;
  if (used.length === 0) return `${conditions} 비슷한 때끼리 견줬습니다`;
  const examples = used.slice(0, 2).map((bin) => bin.label).join(', ');
  return `${conditions} 비슷한 구간 ${used.length}개(${examples}${used.length > 2 ? ' 등' : ''})만 골라, ${comparedCounts(sum(used.map((bin) => bin.nRef)), sum(used.map((bin) => bin.nCur)), e.countWord)}`;
}

function tankLeakBasis(e: TankLeakEvidence): string {
  const recent = e.holds.filter((hold) => hold.role === 'recent').length;
  const reference = e.holds.length - recent;
  return `수소를 넣지도 빼지도 않은 구간 최근 ${recent}개와 예전 ${reference}개에서, 온도 때문에 생기는 압력 변화를 빼고 남은 무게 변화만 봤습니다`;
}

function massBalanceBasis(e: MassBalanceEvidence): string {
  return `최근 ${e.recent.days}일과 예전 ${e.reference.days}일의 하루 수소 장부(만든 양 − 쓴 양 − 저장에 늘어난 양)를 견줬습니다`;
}

/** 오염이 씻긴 사건: 화면 용어(성능지수 급상승) 대신 현장 말로 */
const RESET_WORDS: Readonly<Record<string, string>> = { cleaning: '세척으로', pi_step: '비나 세척으로' };

function soilingBasis(e: SoilingEvidence): string {
  const segment = e.segments.at(-1);
  const clearDays = segment?.clearDays ?? e.piPoints.length;
  const reset = e.resets.at(-1);
  const since = reset === undefined ? '' : `. ${reset.date}에 ${RESET_WORDS[reset.kind] ?? '한 번'} 깨끗해진 뒤부터 잰 값입니다`;
  return `구름 없이 맑았던 날 ${clearDays}일만 골라, 기온 차이를 보정한 발전 성적이 날마다 얼마씩 떨어지는지 쟀습니다${since}`;
}

function thermalBasis(e: ThermalEvidence): string {
  return `최근 ${e.days.length}일을 바깥 기온이 비슷한 날끼리 묶어 같은 사이트의 다른 인버터들과 견줬고, 출력을 일부러 줄인 시간은 뺐습니다`;
}

/** 근거 스냅샷을 읽을 수 없으면 null (문장을 지어내지 않는다) */
export function plainBasis(evidence: EvidenceView): string | null {
  switch (evidence.kind) {
    case 'capacity':
      return `${capacityBasis(evidence)}.`;
    case 'stack':
      return `${stackBasis(evidence)}.`;
    case 'cell_imbalance':
      return `${cellImbalanceBasis(evidence)}.`;
    case 'pv_peer':
      return `${pvPeerBasis(evidence)}.`;
    case 'dq':
      return `${dqBasis(evidence)}.`;
    case 'rise':
      return `${riseBasis(evidence)}.`;
    case 'tank_leak':
      return `${tankLeakBasis(evidence)}.`;
    case 'mass_balance':
      return `${massBalanceBasis(evidence)}.`;
    case 'soiling':
      return `${soilingBasis(evidence)}.`;
    case 'thermal':
      return `${thermalBasis(evidence)}.`;
    default:
      return null;
  }
}
