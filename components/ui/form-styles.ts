// 입력·버튼 클래스. 'use client'가 없는 모듈이라 서버 컴포넌트에서도 문자열로 쓸 수 있다
// (클라이언트 모듈의 export를 서버에서 가져오면 값이 아니라 클라이언트 참조가 된다).

export const CONTROL_CLASS =
  'w-full rounded-md border border-rule-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted disabled:opacity-60 aria-[invalid=true]:border-crit';

const BUTTON_VARIANTS = {
  primary: 'border-transparent bg-accent text-accent-ink hover:bg-accent/90',
  secondary: 'border-rule bg-surface text-ink-2 hover:bg-sunken hover:text-ink',
  danger: 'border-crit/50 bg-surface text-crit hover:bg-crit-fill',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function buttonClass(variant: ButtonVariant = 'primary'): string {
  return `inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_VARIANTS[variant]}`;
}
