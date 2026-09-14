// 메시지 템플릿용 팩 경로 도우미 (순수). 값은 늘 팩에서 경로로 읽어 토큰으로 남긴다 — 템플릿이 숫자를 직접 쓰지 않게.
import type { EvidencePack } from '../pack-types';
import { joinPieces, resolvePath, seq, tokenPiece, type Piece } from '../tokens';

export interface Scope {
  readonly pack: EvidencePack;
  path(sub: string): string;
  /** 표시할 수 있는 값(유한한 수 또는 빈 문자열이 아닌 글자)이 있는가 */
  has(sub: string): boolean;
  at(sub: string): Scope;
  num(sub: string, digits?: number, abs?: boolean): Piece;
  signed(sub: string, digits?: number): Piece;
  pct(sub: string, digits?: number): Piece;
  date(sub: string): Piece;
  dur(sub: string): Piece;
  label(sub: string): Piece;
}

const present = (value: unknown): boolean => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value !== '');

export function scopeOf(pack: EvidencePack, prefix = ''): Scope {
  const path = (sub: string): string => (prefix === '' ? sub : sub.startsWith('[') ? `${prefix}${sub}` : `${prefix}.${sub}`);
  return {
    pack,
    path,
    has: (sub) => present(resolvePath(pack, path(sub))),
    at: (sub) => scopeOf(pack, path(sub)),
    num: (sub, digits = 0, abs = false) => tokenPiece(pack, path(sub), { format: 'number', digits, abs }),
    signed: (sub, digits = 1) => tokenPiece(pack, path(sub), { format: 'signed', digits, abs: false }),
    pct: (sub, digits = 0) => tokenPiece(pack, path(sub), { format: 'percent', digits, abs: false }),
    date: (sub) => tokenPiece(pack, path(sub), { format: 'date', digits: 0, abs: false }),
    dur: (sub) => tokenPiece(pack, path(sub), { format: 'duration', digits: 0, abs: false }),
    label: (sub) => tokenPiece(pack, path(sub), { format: 'label', digits: 0, abs: false }),
  };
}

/** 조건이 참인 조각만 모은다 */
export function when(condition: boolean, build: () => Piece | string): Piece | string {
  return condition ? build() : '';
}

/** 값이 있는 조각만 구분자로 잇는다 */
export function joinPresent(pieces: readonly (Piece | null)[], separator: string): Piece {
  return joinPieces(pieces.filter((p): p is Piece => p !== null), separator);
}

export { seq, joinPieces, type Piece };
