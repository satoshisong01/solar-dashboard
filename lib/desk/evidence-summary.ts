// 효과 카드의 조건 문장 (탐지기별). 순수 모듈. 용량 감소는 conditions.ts의 같은 조건 문장, P3는 p3-view.ts를 쓴다.
import { formatNumber } from '@/lib/format';
import { capacityConditionSentence } from './conditions';
import type { EvidenceView } from './evidence-types';
import { p3ConditionText } from './p3-view';

export function evidenceConditionText(evidence: EvidenceView): string | null {
  switch (evidence.kind) {
    case 'capacity':
      return capacityConditionSentence({ metric: evidence.metric, bins: evidence.bins, widths: evidence.widths, rules: evidence.rules });
    case 'stack': {
      const n = evidence.bins.reduce((sum, bin) => sum + bin.n, 0);
      const breakIn = evidence.breakInHours === null ? '' : `break-in ${formatNumber(evidence.breakInHours, 0)} h 이후`;
      const excluded = evidence.excludedBreakIn ? ` (이전 ${evidence.excludedBreakIn}구간 제외)` : '';
      return `정상운전 ${n}구간, ${breakIn}${excluded}, 같은 전류밀도·온도 구간 ${evidence.bins.length}개로 맞춘 누적 운전시간 축 추세`;
    }
    case 'cell_imbalance':
      return `${evidence.source === 'rest' ? '휴지' : '충전 종료'} 셀 전압 편차(최고−최저), 기준 ${evidence.reference.n}회·최근 ${evidence.recent.n}회${evidence.peers.values.length > 0 ? `, 동종 랙 ${evidence.peers.values.length}대 비교` : ''}`;
    case 'pv_peer': {
      const flagged = evidence.days.filter((d) => d.flagged).length;
      const peers = Math.max(0, ...evidence.days.map((d) => d.peers ?? 0));
      return `같은 사이트 동종 인버터 ${peers}대(자신 포함) 일 kWh/kWp 비교, 평가 ${evidence.days.length}일 중 ${flagged}일 낮음${evidence.excludedDays ? `, 출력제한·클리핑·정지일 ${evidence.excludedDays}일 제외` : ''}`;
    }
    case 'dq':
      return `포인트 ${evidence.points.length}개 요약 (결측 ${evidence.gapPoints ?? 0}개 · 고착 ${evidence.flatlinePoints ?? 0}개)`;
    case 'rise':
    case 'tank_leak':
    case 'mass_balance':
    case 'soiling':
    case 'thermal':
      return p3ConditionText(evidence);
    default:
      return null;
  }
}
