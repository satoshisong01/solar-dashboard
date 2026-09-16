// 로그인 화면 '아이디 저장'의 저장소 접근. 브라우저 localStorage만 쓰고 비밀번호는 절대 저장하지 않는다.
// 'server-only'를 넣지 않는다: 클라이언트 컴포넌트가 가져다 쓴다.
// 사생활 보호 모드나 저장소 차단 설정에서는 접근 자체가 예외를 던지므로 모든 호출을 감싼다.

/** localStorage 키. 다른 앱과 겹치지 않도록 제품 접두사를 붙인다. */
export const REMEMBERED_EMAIL_KEY = 'hysol.login.email';

/** localStorage 중 실제로 쓰는 부분만. 테스트에서 가짜 구현을 넣는다. */
export type EmailStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** 브라우저 localStorage. 서버 렌더링이거나 접근이 막히면 null. */
function browserStore(): EmailStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 저장된 이메일. 저장한 적이 없거나 읽을 수 없으면 빈 문자열. */
export function readRememberedEmail(store: EmailStore | null = browserStore()): string {
  try {
    return store?.getItem(REMEMBERED_EMAIL_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 이메일을 저장한다. 빈 값이면 저장하지 않고 기존 값을 지운다. */
export function saveRememberedEmail(email: string, store: EmailStore | null = browserStore()): void {
  const trimmed = email.trim();
  if (trimmed === '') {
    clearRememberedEmail(store);
    return;
  }
  try {
    store?.setItem(REMEMBERED_EMAIL_KEY, trimmed);
  } catch {
    // 용량 초과·저장소 차단. 저장에 실패해도 로그인은 그대로 진행한다.
  }
}

/** 저장된 이메일을 지운다. */
export function clearRememberedEmail(store: EmailStore | null = browserStore()): void {
  try {
    store?.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    // 저장소 차단. 지울 값이 없는 것과 같게 취급한다.
  }
}
