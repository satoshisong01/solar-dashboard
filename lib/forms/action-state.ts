// Server Action ↔ 폼 공용 결과 타입과 도우미. 순수 모듈 (서버·클라이언트 공용, zod는 타입만 가져온다).
import type { ZodError } from 'zod';

export type FormValues = Readonly<Record<string, string>>;
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * seq는 제출마다 1씩 늘어난다. 폼 key로 쓰면 오류 뒤 입력값(values)을 defaultValue로 다시 채워 넣을 수 있다
 * (React는 action 폼을 제출 뒤 초기화한다).
 */
export type ActionState<T = null> =
  | Readonly<{ status: 'idle'; seq: number }>
  | Readonly<{ status: 'error'; seq: number; message: string; fieldErrors: FieldErrors; values: FormValues }>
  | Readonly<{ status: 'success'; seq: number; message: string; data: T }>;

export const IDLE_STATE: ActionState<never> = Object.freeze({ status: 'idle', seq: 0 });

/** Next가 붙이는 $ACTION_ 필드와 파일은 빼고 문자열 값만. omit의 필드(비밀번호 등)는 되돌려 보내지 않는다 */
export function formValues(formData: FormData, omit: readonly string[] = []): FormValues {
  const entries = [...formData.entries()].filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].startsWith('$ACTION') && !omit.includes(entry[0]),
  );
  return Object.freeze(Object.fromEntries(entries));
}

/** 필드마다 첫 오류 문구. 경로가 없는 오류(객체 전체 refine)는 '' 키 */
export function fieldErrorsOf(error: ZodError): FieldErrors {
  const pairs = error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message] as const);
  const first = pairs.filter(([path], index) => pairs.findIndex(([other]) => other === path) === index);
  return Object.freeze(Object.fromEntries(first));
}

export function errorState<T>(
  prev: ActionState<T>,
  message: string,
  extra: Readonly<{ values?: FormValues; fieldErrors?: FieldErrors }> = {},
): ActionState<T> {
  return { status: 'error', seq: prev.seq + 1, message, fieldErrors: extra.fieldErrors ?? {}, values: extra.values ?? {} };
}

export function successState<T>(prev: ActionState<T>, message: string, data: T): ActionState<T> {
  return { status: 'success', seq: prev.seq + 1, message, data };
}

export const INVALID_FORM_MESSAGE = '입력값을 확인하세요.';
