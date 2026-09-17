// 입력·버튼 클래스. 'use client'가 없는 모듈이라 서버 컴포넌트에서도 문자열로 쓸 수 있다
// (클라이언트 모듈의 export를 서버에서 가져오면 값이 아니라 클라이언트 참조가 된다).

// lg 미만에서만 손가락 크기(44px)와 iOS가 확대하지 않는 글자 크기(16px)로 키운다. lg 이상은 지금 모양 그대로.
export const CONTROL_CLASS =
  'w-full min-h-11 rounded-md border border-rule-strong bg-field px-2.5 py-1.5 text-base text-ink placeholder:text-muted disabled:opacity-60 lg:min-h-0 lg:text-sm aria-[invalid=true]:border-crit';

/** 네이티브 체크박스·라디오. 크기를 안 주면 13px이라 손가락으로 못 누른다 (lg 이상은 브라우저 기본값 그대로) */
export const CHECK_CLASS = 'size-5 shrink-0 accent-accent lg:size-auto';

const BUTTON_VARIANTS = {
  primary: 'border-transparent bg-accent text-accent-ink hover:bg-accent/90 hover:shadow-glow',
  secondary: 'border-rule-strong bg-sunken text-ink-2 hover:bg-rule hover:text-ink',
  danger: 'border-crit/60 bg-crit-fill text-crit hover:bg-crit/25',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function buttonClass(variant: ButtonVariant = 'primary'): string {
  return `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors lg:min-h-0 disabled:cursor-not-allowed disabled:opacity-80 ${BUTTON_VARIANTS[variant]}`;
}
