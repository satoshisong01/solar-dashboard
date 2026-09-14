'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { banConsoleUser, createConsoleAdmin, revokeConsoleUserSessions, unbanConsoleUser } from '@/lib/auth/admin-users';
import { requireAdmin } from '@/lib/auth/dal';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseAdminForm, parseUserIdForm } from '@/lib/forms/settings';

/** 관리자 계정 생성 (가입은 비활성이라 콘솔·스크립트로만 만든다). 임시 비밀번호는 되돌려 보내지 않는다 */
export async function createAdminAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseAdminForm(formValues(formData));
  const values = formValues(formData, ['password']);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await createConsoleAdmin(parsed.input);
  if (!result.ok) return errorState(prev, result.message, { values });

  revalidatePath('/settings/admins');
  return successState(prev, `관리자 ${parsed.input.email} 계정을 만들었습니다. 임시 비밀번호는 별도 경로로 전달하세요.`, null);
}

const USER_OPS = ['ban', 'unban', 'revoke'] as const;
type UserOp = (typeof USER_OPS)[number];
const isUserOp = (value: unknown): value is UserOp => typeof value === 'string' && (USER_OPS as readonly string[]).includes(value);

const SUCCESS_MESSAGES: Readonly<Record<UserOp, string>> = {
  ban: '계정을 비활성했습니다. 로그인 세션도 모두 끝났습니다.',
  unban: '계정을 다시 활성했습니다.',
  revoke: '이 계정의 로그인 세션을 모두 폐기했습니다.',
};

/** 비활성(ban)·다시 활성·세션 폐기. 자기 자신은 비활성할 수 없고, 내 세션을 폐기하면 로그인 화면으로 간다 */
export async function userAdminAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const op = formData.get('op');
  const parsed = parseUserIdForm(formValues(formData));
  if (!parsed.ok || !isUserOp(op)) return errorState(prev, '요청이 올바르지 않습니다.');

  const { userId } = parsed.input;
  const self = userId === session.user.id;
  if (self && op === 'ban') return errorState(prev, '자기 자신은 비활성할 수 없습니다.');

  const run = { ban: () => banConsoleUser(userId, session.user.email), unban: () => unbanConsoleUser(userId), revoke: () => revokeConsoleUserSessions(userId) }[op];
  const result = await run();
  if (!result.ok) return errorState(prev, result.message);

  if (self && op === 'revoke') redirect('/login');
  revalidatePath('/settings/admins');
  return successState(prev, SUCCESS_MESSAGES[op], null);
}
