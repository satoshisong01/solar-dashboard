// inv.thermal_derating 메시지: 최근 기간 저감 일수·시간(방열판 판정 온도·동종 차이 기준) + 발전량 대비 손실 % + 95% CI + 같은 외기 bin 저감 시간 변화.
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export function thermalMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'thermal' || !s.has('effect.value')) return genericMessage(s, f);
  const digits = effectDigits(f, 2, false);
  return seq(
    head(s),
    judgementNote(s, f),
    ': 최근 ',
    s.num('evidence.days'),
    '일 중 ',
    s.num('evidence.derateDays'),
    '일, ',
    when(s.has('evidence.hotC'), () => seq('방열판 ', s.num('evidence.hotC'), ' °C 이상에서 ')),
    '동종 중앙값보다 ',
    s.has('evidence.gapPct') ? seq(s.num('evidence.gapPct'), '% 이상 ') : '',
    '낮은 열 저감이 ',
    s.num('evidence.derateHours', 1),
    '시간 있었고, 손실은 발전량 대비 ',
    s.num('effect.value', digits),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits, false),
    ', 약 ',
    s.num('evidence.lossKwh'),
    ' kWh입니다.',
    when(s.has('evidence.refBinDerateH') && s.has('evidence.curBinDerateH'), () => seq(' 같은 외기 조건 일 저감 시간은 기준 ', s.num('evidence.refBinDerateH', 2), ' h → 최근 ', s.num('evidence.curBinDerateH', 2), ' h입니다.')),
    ' 출력제한 시각은 뺐습니다.',
    supportsNote(s, e.checks),
  );
}
