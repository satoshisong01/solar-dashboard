import type { ComponentProps } from 'react';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={`w-full min-h-11 rounded-md border border-rule-strong bg-field px-3 py-2 text-base text-ink placeholder:text-muted disabled:opacity-60 lg:min-h-0 ${className}`}
      {...props}
    />
  );
}
