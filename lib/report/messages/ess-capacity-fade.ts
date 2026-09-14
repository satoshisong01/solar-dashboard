// ess.capacity_fade 메시지 (설계 §3.1 리포트 행): 같은 조건 문장 + 유효용량 Ah + 효과 % + 95% CI + 기준 전류 환산 충전시간 + 추세·SOH 도달 추정.
import type { PackFinding } from '../pack-types';
import { ciNote, genericMessage, head, judgementNote, supportsNote } from './common';
import { joinPresent, seq, when, type Piece, type Scope } from './scope';

function conditionPieces(s: Scope, f: PackFinding): Piece | null {
  if (f.evidence.kind !== 'capacity') return null;
  const e = f.evidence;
  const rule =
    e.metric === 'capacity_ah_anchored'
      ? seq('휴지 후 SOC ≤ ', s.num('evidence.anchorSocMaxPct'), '% 시작 → 완충')
      : e.metric === 'capacity_ah_cc'
        ? seq('휴지 후 시작·CC 구간 SOC 변화 ≥ ', s.num('evidence.minCcSocSpanPct'), '%')
        : seq('SOC 변화 ≥ ', s.num('evidence.minSocSpanPct'), '%인 부분 충전');
  return joinPresent(
    [
      s.has('evidence.cRateLow') && s.has('evidence.cRateHigh') ? seq('충전전류 ', s.num('evidence.cRateLow', 2), '~', s.num('evidence.cRateHigh', 2), 'C') : null,
      s.has('evidence.tempLowC') && s.has('evidence.tempHighC') ? seq('셀온도 ', s.num('evidence.tempLowC'), '~', s.num('evidence.tempHighC'), '°C') : null,
      rule,
      seq('기준 ', s.num('evidence.nRef'), '회·최근 ', s.num('evidence.nCur'), '회'),
    ],
    ', ',
  );
}

export function essCapacityFadeMessage(s: Scope, f: PackFinding): Piece {
  const conditions = conditionPieces(s, f);
  if (f.evidence.kind !== 'capacity' || conditions === null || !s.has('effect.value') || !s.has('effect.baseline') || !s.has('effect.current')) return genericMessage(s, f);
  const hasChargeTime = s.has('evidence.referenceCurrentA') && s.has('evidence.baselineHours') && s.has('evidence.currentHours');
  const hasTrend = s.has('evidence.slopePerMonth');
  return seq(
    head(s),
    judgementNote(s, f),
    ': 같은 조건(',
    conditions,
    ')으로 충전을 비교하면 유효용량이 ',
    s.num('effect.baseline', 1),
    ' Ah → ',
    s.num('effect.current', 1),
    ' Ah로 ',
    s.signed('effect.value', 1),
    '%',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', 1),
    ' 변했습니다.',
    when(hasChargeTime, () => seq(' ', s.num('evidence.referenceCurrentA'), ' A 기준 환산 충전시간은 ', s.dur('evidence.baselineHours'), ' → ', s.dur('evidence.currentHours'), '입니다.')),
    when(hasTrend, () =>
      seq(
        ' 정격 대비 추세 ',
        s.signed('evidence.slopePerMonth', 2),
        '%p/월',
        ciNote(s, 'evidence.slopeCiLow', 'evidence.slopeCiHigh', 2),
        when(s.has('evidence.sohTargetPct') && s.has('evidence.sohTargetDate'), () => seq(', SOH ', s.num('evidence.sohTargetPct'), '% 도달 추정 ', s.date('evidence.sohTargetDate'))),
        '.',
      ),
    ),
    supportsNote(s, f.evidence.checks),
  );
}
