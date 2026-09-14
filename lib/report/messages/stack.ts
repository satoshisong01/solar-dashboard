// 전해조·연료전지 스택 전압 추세 메시지 공통 (설계 §4.1 운전시간 축 열화 추적): 누적 운전시간 µV/h + 95% CI + 운전 구간 동안 변화 mV.
import type { PackFinding } from '../pack-types';
import { ciNote, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export interface StackWording {
  readonly subject: string;
  readonly verb: string;
}

export function stackVoltageMessage(s: Scope, f: PackFinding, wording: StackWording): Piece {
  const e = f.evidence;
  if (e.kind !== 'stack' || !s.has('effect.value')) return genericMessage(s, f);
  const hasRange = s.has('evidence.opHoursFirst') && s.has('evidence.opHoursLast');
  return seq(
    head(s),
    judgementNote(s, f),
    ': ',
    when(s.has('evidence.breakInHours'), () => seq('break-in ', s.num('evidence.breakInHours'), ' h 이후 ')),
    '정상운전 ',
    s.num('evidence.segments'),
    '구간',
    when(hasRange, () => seq('(누적 운전 ', s.num('evidence.opHoursFirst'), '~', s.num('evidence.opHoursLast'), ' h)')),
    '을 같은 전류밀도·온도 구간 ',
    s.num('evidence.binCount'),
    `개로 맞추면 ${wording.subject}이 `,
    s.num('effect.value', 1),
    ' µV/h',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', 1, false),
    `로 ${wording.verb}하고 있습니다.`,
    when(s.has('evidence.opHoursSpan') && s.has('evidence.deltaMv'), () => seq(' 운전 ', s.num('evidence.opHoursSpan'), ' h 동안 셀당 약 ', s.num('evidence.deltaMv', 1), ` mV ${wording.verb}.`)),
    supportsNote(s, e.checks),
  );
}
