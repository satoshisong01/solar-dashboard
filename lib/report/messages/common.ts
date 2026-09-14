// 발견사항 메시지 공통 조각 (순수): 머리말 · 확정/잠정 표기 · 95% CI · 판정 보류 · 함께 확인된 신호 · 권고.
import { effectCiDigits, formatSigned } from '@/lib/desk/effect';
import { formatNumber } from '@/lib/format';
import { directionVerb, effectDirection } from '../direction';
import type { PackCheck, PackFinding } from '../pack-types';
import { joinPresent, seq, when, type Piece, type Scope } from './scope';

/** '[SIM-A/ESS1/RACK01] 배터리 유효용량 감소' */
export function head(s: Scope): Piece {
  return seq('[', s.label('assetPath'), '] ', s.label('detectorLabel'));
}

/** ' (확정, 신뢰도 85%·탐지 3회)' 또는 ' (잠정, …)' */
export function judgementNote(s: Scope, f: PackFinding): Piece {
  return seq(` (${f.judgement === 'confirmed' ? '확정' : '잠정'}, 신뢰도 `, s.pct('confidence'), '%·탐지 ', s.num('history.detectionCount'), '회)');
}

/** 효과·CI 표시 자릿수: base부터 점추정과 CI 경계가 같은 글자로 보이면 늘린다 (분석 데스크와 같은 규칙, 토큰 표기 형식으로 비교) */
export function effectDigits(f: PackFinding, base: number, signed = true): number {
  return effectCiDigits(f.effect, base, signed ? formatSigned : (value, digits) => formatNumber(value, digits));
}

/** 효과 부호로 만든 동사: '감소했습니다' · '증가하고 있습니다' */
export function effectVerb(f: PackFinding, form: 'past' | 'progressive' = 'past'): string {
  return directionVerb(effectDirection(f.effect.metric, f.effect.value), form);
}

/** '(95% CI −7.5 ~ −7.2)' — 둘 다 있을 때만 */
export function ciNote(s: Scope, lowPath: string, highPath: string, digits: number, signed = true): Piece | string {
  if (!s.has(lowPath) || !s.has(highPath)) return '';
  const value = (path: string) => (signed ? s.signed(path, digits) : s.num(path, digits));
  return seq('(95% CI ', value(lowPath), ' ~ ', value(highPath), ')');
}

const SPAN_UNITS = { days: '일', op_hours: ' h' } as const;

/** 최소 데이터 기간 미달: 효과 수치 없이 관찰 중으로만 쓴다 (설계 §5.3 신뢰도 낮은 결과는 "관찰 중") */
export function holdMessage(s: Scope, f: PackFinding): Piece {
  const unit = SPAN_UNITS[f.minDataSpan?.unit ?? 'days'];
  return seq(
    head(s),
    ' — 판정 보류(관찰 중): 근거 데이터 기간이 최소 ',
    s.has('minDataSpan.value') ? s.num('minDataSpan.value') : '',
    unit,
    '에 못 미칩니다',
    when(s.has('dataSpan.value'), () => seq('(현재 ', s.num('dataSpan.value', 1), unit, ')')),
    '. 데이터가 더 쌓인 뒤 분석을 다시 실행해 판정합니다.',
  );
}

/** ' 함께 확인된 신호: A, B.' (지지 체크만) */
export function supportsNote(s: Scope, checks: readonly PackCheck[]): Piece | string {
  const labels = checks.flatMap((check, index) => (check.status === 'supports' ? [s.label(`evidence.checks[${index}].label`)] : []));
  return labels.length === 0 ? '' : seq(' 함께 확인된 신호: ', joinPresent(labels, ', '), '.');
}

/** 권고 조치 2개 + 기각 전 확인할 오탐 요인 2개 (플레이북) */
export function adviceMessage(s: Scope, f: PackFinding): Piece | null {
  if (!f.playbook || f.playbook.actions.length === 0) return null;
  const actions = f.playbook.actions.slice(0, 2).map((_, i) => s.label(`playbook.actions[${i}]`));
  const traps = f.playbook.falsePositiveTraps.slice(0, 2).map((_, i) => s.label(`playbook.falsePositiveTraps[${i}]`));
  return seq('권고: ', joinPresent(actions, '; '), '.', when(traps.length > 0, () => seq(' 기각 전 확인할 오탐 요인: ', joinPresent(traps, ', '), '.')));
}

/** 모르는 탐지기: 제목만 이름 토큰으로 인용 */
export function genericMessage(s: Scope, f: PackFinding): Piece {
  return seq(head(s), judgementNote(s, f), ': ', s.label('title'), '.');
}
