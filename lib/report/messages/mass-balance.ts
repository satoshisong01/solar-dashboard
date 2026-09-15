// h2chain.mass_balance_gap 메시지: 최근 일 잔차율 중앙값 + 95% CI + 기준 대비 방향(효과 부호) + CUSUM 경보일 + 하루 잔차 kg + 인증 산정 아님.
import { effectDirection } from '../direction';
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export function massBalanceMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'mass_balance' || !s.has('effect.value')) return genericMessage(s, f);
  const digits = effectDigits(f, 2);
  const stem = effectDirection(f.effect.metric, f.effect.value) === 'decrease' ? '감소' : '증가';
  const lossSide = (e.recentMedianKg ?? 0) >= 0;
  return seq(
    head(s),
    judgementNote(s, f),
    ': 최근 유효 ',
    s.num('evidence.recentDays'),
    '일의 일 잔차율 중앙값이 ',
    s.signed('effect.value', digits),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits),
    '로 기준 ',
    s.num('evidence.referenceDays'),
    '일',
    when(s.has('evidence.referenceMedianPct'), () => seq(' 중앙값 ', s.signed('evidence.referenceMedianPct', 2), '%')),
    ` 대비 ${stem}했`,
    s.has('evidence.alarmDay') ? seq('고, CUSUM 경보가 ', s.date('evidence.alarmDay'), '에 났습니다.') : '습니다.',
    when(s.has('evidence.recentMedianKg'), () =>
      seq(' 하루 약 ', s.num('evidence.recentMedianKg', 2, true), ` kg이 ${lossSide ? '계량으로 설명되지 않는 손실(또는 생산 과다 계량)' : '설명되지 않는 유입(또는 소비·저장 과다 계량)'}입니다.`),
    ),
    supportsNote(s, e.checks),
    ' 원장 할당·계량 추정 기반이며 청정수소 인증 공식 산정이 아닙니다.',
  );
}
