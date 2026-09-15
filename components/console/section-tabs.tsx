import Link from 'next/link';

export interface SectionTab {
  readonly href: string;
  readonly label: string;
}

type SectionTabsProps = Readonly<{ label: string; tabs: readonly SectionTab[]; current: string | null }>;

const TAB_CLASS =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ' +
  'border-rule bg-surface text-ink-2 hover:bg-sunken hover:text-ink ' +
  'aria-[current=page]:border-accent aria-[current=page]:bg-hydrogen-fill aria-[current=page]:text-ink';

/** 한 메뉴 안의 하위 화면 이동. current는 지금 화면의 href (없으면 null) */
export function SectionTabs({ label, tabs, current }: SectionTabsProps) {
  return (
    <nav aria-label={label} className="-mt-2 overflow-x-auto">
      <ul className="flex gap-2 pb-1">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link href={tab.href} aria-current={tab.href === current ? 'page' : undefined} className={TAB_CLASS}>
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const DATA_TABS: readonly SectionTab[] = [
  { href: '/data', label: '게이트웨이' },
  { href: '/data/unmapped', label: '미매핑 태그' },
  { href: '/data/quality', label: '데이터 품질' },
  { href: '/data/readiness', label: '탐지 준비도' },
];

export const SETTINGS_TABS: readonly SectionTab[] = [
  { href: '/settings/catalog', label: '카탈로그' },
  { href: '/settings/detectors', label: '탐지기' },
  { href: '/settings/gateways', label: '게이트웨이·키' },
  { href: '/settings/admins', label: '관리자' },
  { href: '/settings/market', label: '시장가격' },
];
