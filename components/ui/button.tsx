import type { ComponentProps } from 'react';

const VARIANTS = {
  primary: 'border-transparent bg-accent text-accent-ink hover:bg-accent/90 hover:shadow-glow',
  secondary: 'border-rule-strong bg-sunken text-ink-2 hover:bg-rule hover:text-ink',
} as const;

type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof VARIANTS;
};

export function Button({ variant = 'primary', type = 'button', className = '', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors lg:min-h-0 disabled:cursor-not-allowed disabled:opacity-80 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
