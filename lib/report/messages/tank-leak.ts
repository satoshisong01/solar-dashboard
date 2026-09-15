// tank.static_leak 메시지: 정지 보유 구간 온도 보정 질량 감소 kg/일 + 95% CI + 센서 잡음 대비 유의 + 안전 기준·현장 확인 + 대체 불가 고정 문구.
import { SAFETY_FINDING_NOTICE } from '@/lib/desk/safety';
import type { PackFinding } from '../pack-types';
import { ciNote, effectDigits, effectVerb, genericMessage, head, judgementNote, supportsNote } from './common';
import { seq, when, type Piece, type Scope } from './scope';

export function tankLeakMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'tank_leak' || !s.has('effect.value')) return genericMessage(s, f);
  const digits = effectDigits(f, 2, false);
  const safety = e.safetyCategory && s.has('evidence.safetyKgPerDay');
  return seq(
    head(s),
    judgementNote(s, f),
    ': 정지 보유 구간 ',
    s.num('evidence.recentHolds'),
    '개',
    when(s.has('evidence.medianHoldHours'), () => seq('(길이 중앙값 ', s.num('evidence.medianHoldHours', 1), ' h)')),
    '의 온도 보정 질량(',
    s.label('evidence.eosLabel'),
    ')이 하루 ',
    s.num('effect.value', digits),
    ' kg',
    ciNote(s, 'effect.ciLow', 'effect.ciHigh', digits, false),
    ` ${effectVerb(f)}.`,
    when(s.has('evidence.pctPerDay'), () => seq(' 하루 저장량의 ', s.num('evidence.pctPerDay', 2), '%입니다.')),
    when(s.has('evidence.noiseSigmaKgPerDay') && s.has('evidence.thresholdKgPerDay'), () =>
      seq(' 기준 구간 ', s.num('evidence.referenceHolds'), '개로 잰 센서 잡음 수준(σ ', s.num('evidence.noiseSigmaKgPerDay', 3), ' kg/일)의 유의 기준 ', s.num('evidence.thresholdKgPerDay', 3), ' kg/일을 넘습니다.'),
    ),
    safety
      ? seq(' 누설률 95% CI 하한이 안전 기준 ', s.num('evidence.safetyKgPerDay', 2), ' kg/일을 넘는 안전 발견사항입니다. 가스 검지기 기록 확인과 누설 점검을 즉시 진행하고, 운전 정지 여부는 현장 안전책임자가 판단하세요.')
      : ' 미세 누설 의심 단계입니다. 가스 검지기 기록 확인과 휴대용 검지기·발포액 누설 점검을 권고합니다.',
    supportsNote(s, e.checks),
    ` ${SAFETY_FINDING_NOTICE}`,
  );
}
