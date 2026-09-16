import { ScreenGuide } from './screen-guide';

type PageHeaderProps = Readonly<{
  title: string;
  /** 무엇을 하는 화면인지 (기존 한 줄 설명) */
  purpose: string;
  /** 전문 용어를 모르는 사람을 위한 한 줄 안내. 끄고 켤 수 있다 */
  guide?: string;
}>;

export function PageHeader({ title, purpose, guide }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-1.5 border-b border-rule pb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-balance text-ink">{title}</h1>
      <p className="text-ink-2">{purpose}</p>
      {guide !== undefined && <ScreenGuide text={guide} />}
    </header>
  );
}
