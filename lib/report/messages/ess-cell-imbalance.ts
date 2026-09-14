// ess.cell_imbalance 메시지: 셀 전압 편차 기준 → 최근 mV + 변화 + 95% CI + 월 추세 + 동종 랙 비교.
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, effectVerb, genericMessage, head, judgementNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export function essCellImbalanceMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'cell_imbalance' || !s.has('effect.value') || !s.has('effect.baseline') || !s.has('effect.current')) return genericMessage(s, f);
  const digits = effectDigits(f, 1);
  return seq(
    head(s),
    judgementNote(s, f),
    `: ${e.source === 'rest' ? '휴지' : '충전 종료'} 셀 전압 편차(최고−최저)가 기준 `,
    s.num('effect.baseline', 1),
    ' mV(',
    s.num('evidence.nRef'),
    '회) → 최근 ',
    s.num('effect.current', 1),
    ' mV(',
    s.num('evidence.nCur'),
    '회)로 ',
    s.signed('effect.value', digits),
    ' mV',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits),
    ` ${effectVerb(f)}.`,
    when(s.has('evidence.slopeMvPerMonth'), () => seq(' 추세 ', s.signed('evidence.slopeMvPerMonth', 1), ' mV/월', ciNote(s, 'evidence.slopeCiLow', 'evidence.slopeCiHigh', 1), '.')),
    when(e.peerCount > 0 && s.has('evidence.peerZ'), () => seq(' 동종 랙 ', s.num('evidence.peerCount'), '대 대비 수정 z ', s.num('evidence.peerZ', 1), '.')),
  );
}
