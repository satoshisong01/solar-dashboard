import { describe, expect, it } from 'vitest';
import {
  REMEMBERED_EMAIL_KEY,
  clearRememberedEmail,
  readRememberedEmail,
  saveRememberedEmail,
  type EmailStore,
} from './remember-email';

/** localStorage 대역. 실제 구현처럼 문자열만 담는다. */
function fakeStore(initial: Readonly<Record<string, string>> = {}): EmailStore & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** 사생활 보호 모드처럼 접근 자체가 예외를 던지는 저장소. */
const throwingStore: EmailStore = {
  getItem: () => {
    throw new DOMException('blocked');
  },
  setItem: () => {
    throw new DOMException('blocked');
  },
  removeItem: () => {
    throw new DOMException('blocked');
  },
};

describe('아이디 저장', () => {
  it('저장한 이메일을 그대로 복원한다', () => {
    const store = fakeStore();
    saveRememberedEmail('admin@hysol.local', store);
    expect(store.map.get(REMEMBERED_EMAIL_KEY)).toBe('admin@hysol.local');
    expect(readRememberedEmail(store)).toBe('admin@hysol.local');
  });

  it('저장한 적이 없으면 빈 문자열이다', () => {
    expect(readRememberedEmail(fakeStore())).toBe('');
  });

  it('앞뒤 공백은 저장할 때와 읽을 때 모두 떼어 낸다', () => {
    const store = fakeStore({ [REMEMBERED_EMAIL_KEY]: '  spaced@hysol.local \n' });
    expect(readRememberedEmail(store)).toBe('spaced@hysol.local');

    saveRememberedEmail('  admin@hysol.local  ', store);
    expect(store.map.get(REMEMBERED_EMAIL_KEY)).toBe('admin@hysol.local');
  });

  it('해제하면 저장값을 지운다', () => {
    const store = fakeStore({ [REMEMBERED_EMAIL_KEY]: 'admin@hysol.local' });
    clearRememberedEmail(store);
    expect(store.map.has(REMEMBERED_EMAIL_KEY)).toBe(false);
    expect(readRememberedEmail(store)).toBe('');
  });

  it('빈 값을 저장하면 기존 값을 지운다', () => {
    const store = fakeStore({ [REMEMBERED_EMAIL_KEY]: 'admin@hysol.local' });
    saveRememberedEmail('   ', store);
    expect(store.map.has(REMEMBERED_EMAIL_KEY)).toBe(false);
  });

  it('저장소 접근이 막혀도 예외를 내지 않는다', () => {
    expect(readRememberedEmail(throwingStore)).toBe('');
    expect(() => saveRememberedEmail('admin@hysol.local', throwingStore)).not.toThrow();
    expect(() => clearRememberedEmail(throwingStore)).not.toThrow();
  });

  it('저장소가 없어도(서버 렌더링) 예외를 내지 않는다', () => {
    // Node 환경에는 localStorage가 없다. 기본 인자 경로도 함께 확인한다.
    expect(readRememberedEmail(null)).toBe('');
    expect(() => saveRememberedEmail('admin@hysol.local', null)).not.toThrow();
    expect(() => clearRememberedEmail(null)).not.toThrow();

    expect(readRememberedEmail()).toBe('');
    expect(() => saveRememberedEmail('admin@hysol.local')).not.toThrow();
    expect(() => clearRememberedEmail()).not.toThrow();
  });
});
