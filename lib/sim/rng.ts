// 시드 PRNG. Math.random은 쓰지 않는다: 같은 시드 → 같은 출력.
// 용도별로 스트림을 나눠(deriveRng) 시나리오를 추가해도 다른 난수열이 흔들리지 않게 한다.

export interface Rng {
  /** [0, 1) 균등 */
  next(): number;
  /** 표준정규 N(0, 1) — Box–Muller */
  gaussian(): number;
  /** [min, max) 균등 */
  uniform(min: number, max: number): number;
  /** 확률 p로 true */
  chance(p: number): boolean;
}

/** mulberry32: 32비트 상태, 주기 2^32. 시뮬레이션 용도로 충분하다(암호용 아님). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 문자열·숫자 조합 → 32비트 시드 (FNV-1a 후 murmur3 finalizer로 비트 확산) */
export function hashSeed(...parts: readonly (string | number)[]): number {
  const text = parts.join('');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  let spare: number | null = null;

  const gaussian = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const u1 = 1 - next(); // (0, 1] → log(0) 방지
    const u2 = next();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };

  return {
    next,
    gaussian,
    uniform: (min, max) => min + (max - min) * next(),
    chance: (p) => next() < p,
  };
}

/** 시드와 용도 이름으로 독립 스트림을 만든다. 예: deriveRng(seed, 'SIM-B', 'noise') */
export const deriveRng = (seed: number, ...parts: readonly (string | number)[]): Rng =>
  createRng(hashSeed(seed, ...parts));
