type PageHeaderProps = Readonly<{ title: string; purpose: string }>;

export function PageHeader({ title, purpose }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-1.5 border-b border-rule pb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-balance text-ink">{title}</h1>
      <p className="text-ink-2">{purpose}</p>
    </header>
  );
}
