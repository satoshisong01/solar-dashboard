// pv.soiling_rate 메시지: 맑은 날 성능지수 구간 기울기(오염 속도 %/일) + 누적 손실 % + 95% CI + 방향 단어 + 손실 kWh·세척 경제성(SMP 없으면 판단 안 함).
import { effectDirection } from '../direction';
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

function economics(s: Scope, f: PackFinding): Piece | string {
  const e = f.evidence;
  if (e.kind !== 'soiling' || !s.has('evidence.cumulativeLossKwh')) return '';
  const priced = s.has('evidence.lossValueKrw') && s.has('evidence.smpKrwPerKwh');
  return seq(
    ' 누적 손실 약 ',
    s.num('evidence.cumulativeLossKwh'),
    ' kWh',
    when(s.has('evidence.dailyLossKwh'), () => seq('(최근 하루 약 ', s.num('evidence.dailyLossKwh'), ' kWh)')),
    '로 추정됩니다.',
    priced
      ? seq(
          ' SMP ',
          s.num('evidence.smpKrwPerKwh', 1),
          '원/kWh 기준 손실액 약 ',
          s.num('evidence.lossValueKrw'),
          '원',
          when(s.has('evidence.cleaningCostKrw') && s.has('evidence.shareOfCleaningPct'), () => seq('으로 세척 1회 비용 ', s.num('evidence.cleaningCostKrw'), '원의 ', s.num('evidence.shareOfCleaningPct'), '%')),
          `입니다.${(e.shareOfCleaningPct ?? 0) >= 100 ? ' 누적 손실액이 세척비를 넘었으니 세척을 검토하세요.' : ''}`,
        )
      : ' 가격 데이터가 없어 세척 경제성은 판단하지 않았습니다.',
  );
}

export function soilingMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'soiling' || !s.has('effect.value') || !s.has('evidence.ratePctPerDay')) return genericMessage(s, f);
  const digits = effectDigits(f, 1, false);
  const verb = effectDirection(f.effect.metric, f.effect.value) === 'decrease' ? '줄었습니다' : '늘었습니다';
  return seq(
    head(s),
    judgementNote(s, f),
    ': 맑은 날 ',
    s.num('evidence.clearDays'),
    '일의 온도 보정 성능지수로 보면 ',
    s.has('evidence.lastResetDay') && s.has('evidence.lastResetLabel') ? seq('마지막 복원(', s.date('evidence.lastResetDay'), ' ', s.label('evidence.lastResetLabel'), ') 이후 ') : '데이터 시작 이후 ',
    '오염 속도 ',
    s.num('evidence.ratePctPerDay', 2),
    '%/일',
    ciNote(s, 'evidence.rateCiLow', 'evidence.rateCiHigh', 2, false),
    '로 누적 손실이 약 ',
    s.num('effect.value', digits),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits, false),
    `까지 ${verb}.`,
    economics(s, f),
    supportsNote(s, e.checks),
  );
}
