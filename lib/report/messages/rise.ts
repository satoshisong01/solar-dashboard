// P3 같은 조건 상승 4종 메시지 (el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth):
// 같은 조건 bin·표본 수 + 기준 → 최근 수준 + 효과 % + 95% CI + 방향 단어(효과 부호) + 추세 기울기 + 함께 확인된 신호.
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, effectVerb, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

/** 주어 조사 (받침 있으면 이) */
const PARTICLES: Readonly<Record<string, string>> = { 'el.sec_rise': '가', 'comp.sec_rise': '가', 'fc.blower_wear': '이', 'ess.resistance_growth': '이' };
const LEVEL_DIGITS: Readonly<Record<string, number>> = { 'el.sec_rise': 2, 'comp.sec_rise': 3, 'fc.blower_wear': 2, 'ess.resistance_growth': 1 };

export function riseMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'rise' || !s.has('effect.value') || !s.has('effect.baseline') || !s.has('effect.current') || !s.has('evidence.conditionLabel')) return genericMessage(s, f);
  const digits = effectDigits(f, 1);
  const level = LEVEL_DIGITS[f.detectorId] ?? 2;
  const unit = f.effect.levelUnit ?? '';
  return seq(
    head(s),
    judgementNote(s, f),
    ': 같은 조건(',
    s.label('evidence.conditionLabel'),
    ', 기준 ',
    s.num('evidence.nRef'),
    `${e.countWord}·최근 `,
    s.num('evidence.nCur'),
    e.countWord,
    ')으로 비교하면 ',
    s.label('evidence.subject'),
    when(f.detectorId === 'ess.resistance_growth' && s.has('effect.metric'), () => seq('(', s.label('effect.metric'), ')')),
    `${PARTICLES[f.detectorId] ?? '이'} `,
    s.num('effect.baseline', level),
    ` ${unit} → `,
    s.num('effect.current', level),
    ` ${unit}로 `,
    s.signed('effect.value', digits),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits),
    ` ${effectVerb(f)}.`,
    when(s.has('evidence.trendSlope') && s.has('evidence.trendUnit'), () =>
      seq(` ${e.trendAxis} 추세 `, s.signed('evidence.trendSlope', 2), ' ', s.label('evidence.trendUnit'), ciNote(s, 'evidence.trendCiLow', 'evidence.trendCiHigh', 2), '.'),
    ),
    supportsNote(s, e.checks),
  );
}
