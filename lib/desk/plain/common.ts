// 쉬운 말 요약 공통 조각 (순수): 주어 이름, 수치 표기 규칙, 심각도 말.
import { formatNumber } from '@/lib/format';
import type { PlainSubject } from './types';

/**
 * 반올림 규칙 (문장 전체가 같은 규칙을 쓴다)
 *   - 효과·비율·전압 편차: 소수 1자리
 *   - 누설률 [kg/일]: 소수 2자리 — 안전 기준(0.5 kg/일)과 센서 잡음 기준이 소수 2자리라 1자리로 줄이면 구분이 사라진다
 *   - 금액·에너지·횟수: 소수 없이 천 단위 구분
 */
export const EFFECT_DIGITS = 1;
export const LEAK_DIGITS = 2;

/** 부호 없이 크기만: '7.4' (방향은 문장의 동사가 말한다) */
export const size = (value: number | null, digits: number = EFFECT_DIGITS): string => formatNumber(value === null ? null : Math.abs(value), digits);

/** 금액·에너지·횟수: '4,114' */
export const amount = (value: number | null): string => formatNumber(value, 0);

/** 'SIM-A/ESS1/RACK01' → 'RACK01' */
export function assetCodeOf(assetPath: string | null): string | null {
  const code = assetPath?.split('/').at(-1);
  return code === undefined || code === '' ? null : code;
}

/** 문장의 주어: '배터리 랙 1(RACK01)' · 설비가 없는 사이트 단위는 '영암 태양광·ESS 발전소' */
export function subjectText(subject: PlainSubject): string {
  if (subject.assetName === null) return `${subject.siteName} 발전소`;
  return subject.assetCode === null ? subject.assetName : `${subject.assetName}(${subject.assetCode})`;
}

/** 심각도 1~5를 할 일의 급함으로: 색·숫자 대신 말로 읽게 한다 */
const SEVERITY_ACTIONS: readonly string[] = ['참고', '참고', '지켜보기', '이번 주 확인', '바로 확인', '바로 확인'];

export function severityAction(severity: number): string {
  return SEVERITY_ACTIONS[severity] ?? '참고';
}

/** 값이 늘었는지 줄었는지 ('늘었습니다' / '줄었습니다'). 0이거나 값이 없으면 '변했습니다' */
export function grewOrShrank(value: number | null, grew = '늘었습니다', shrank = '줄었습니다'): string {
  if (value === null || !Number.isFinite(value) || value === 0) return '변했습니다';
  return value > 0 ? grew : shrank;
}

// 조사 고르기: 설비 이름이 '배터리 랙 1(RACK01)'처럼 숫자·영문·괄호로 끝나도 읽는 소리로 받침을 판단한다.
// 받침이 있는 소리로 끝나는 숫자·영문 (0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 / f 에프, l 엘, m 엠, n 엔, r 알, s 에스, x 엑스)
const DIGITS_WITH_BATCHIM = '013678';
const LETTERS_WITH_BATCHIM = 'flmnrsx';

/** 마지막 글자를 읽었을 때 받침이 있는지. 닫는 괄호는 건너뛰고 그 앞 글자를 본다 */
export function hasBatchim(word: string): boolean {
  const last = word.replace(/[)\]}\s.]+$/u, '').at(-1);
  if (last === undefined) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (last >= '0' && last <= '9') return DIGITS_WITH_BATCHIM.includes(last);
  const lower = last.toLowerCase();
  return lower >= 'a' && lower <= 'z' && LETTERS_WITH_BATCHIM.includes(lower);
}

/** 받침에 맞는 조사를 붙인다: withParticle('배터리 랙 1(RACK01)', '이', '가') → '…(RACK01)이' */
export const withParticle = (word: string, afterBatchim: string, afterVowel: string): string => `${word}${hasBatchim(word) ? afterBatchim : afterVowel}`;
