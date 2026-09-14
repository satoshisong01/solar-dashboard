// dq.gap_flatline 메시지 (설계 §4.1 데이터 품질도 코칭 항목): 수신 완결성·결측 시간·고착 포인트 + 점검 요청.
import type { PackFinding } from '../pack-types';
import { genericMessage, head } from './common';
import { joinPresent, seq, type Piece, type Scope } from './scope';

export function dqGapFlatlineMessage(s: Scope, f: PackFinding): Piece {
  const e = f.evidence;
  if (e.kind !== 'dq') return genericMessage(s, f);
  const gap =
    e.gapPoints > 0
      ? seq(
          '수신 결측 포인트 ',
          s.num('evidence.gapPoints'),
          '개',
          s.has('evidence.worstCompletenessPct') && s.has('evidence.longestGapHours') ? seq('(완결성 최저 ', s.num('evidence.worstCompletenessPct', 1), '%, 결측 최대 ', s.num('evidence.longestGapHours', 1), '시간)') : '',
        )
      : null;
  const flat = e.flatlinePoints > 0 ? seq('값 고착 포인트 ', s.num('evidence.flatlinePoints'), '개', s.has('evidence.longestFlatlineHours') ? seq('(최장 ', s.num('evidence.longestFlatlineHours', 1), '시간)') : '') : null;
  if (gap === null && flat === null) return genericMessage(s, f);
  const advice = [gap ? '게이트웨이·통신 경로 점검' : null, flat ? '센서 교정·배선 점검' : null].filter((a): a is string => a !== null).join('과 ');
  return seq(head(s), ': ', joinPresent([gap, flat], ', '), `. ${advice}을 요청합니다.`);
}
