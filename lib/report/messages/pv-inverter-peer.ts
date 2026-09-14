// pv.inverter_peer 메시지: 평가일 중 낮은 날 + 동종 중앙값 → 이 인버터 kWh/kWp + 편차 % + 95% CI + 제외일.
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, genericMessage, head, judgementNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export function pvInverterPeerMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'pv_peer' || !s.has('effect.value') || !s.has('effect.baseline') || !s.has('effect.current')) return genericMessage(s, f);
  return seq(
    head(s),
    judgementNote(s, f),
    ': 평가 ',
    s.num('evidence.days'),
    '일 중 ',
    s.num('evidence.flaggedDays'),
    '일은 같은 사이트 동종 인버터(',
    s.num('evidence.peers'),
    '대) 대비 kWh/kWp가 낮았습니다. 동종 중앙값 ',
    s.num('effect.baseline', 2),
    ' → 이 인버터 ',
    s.num('effect.current', 2),
    ' kWh/kWp, ',
    s.signed('effect.value', effectDigits(f, 2)),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', effectDigits(f, 2)),
    '.',
    when(e.excludedDays > 0, () => seq(' 출력제한·클리핑·정지일 ', s.num('evidence.excludedDays'), '일은 제외했습니다.')),
  );
}
