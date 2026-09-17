import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { BrandMark } from './brand-mark';
import { navGroupsFor } from './nav-items';
import { NavLink } from './nav-link';

const LINK_CLASS =
  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink ' +
  'aria-[current=page]:bg-hydrogen-fill aria-[current=page]:font-medium aria-[current=page]:text-ink ' +
  'aria-[current=page]:shadow-[inset_3px_0_0_var(--accent),0_0_16px_-8px_var(--accent)]';

/** lg 이상에서만 보이는 좌측 사이드바. 그보다 좁으면 상단 바의 서랍 메뉴(MobileNav)가 대신한다. */
export function Sidebar({ showSim }: Readonly<{ showSim: boolean }>) {
  return (
    <div className="sticky top-0 hidden h-dvh flex-col gap-7 overflow-y-auto border-r border-rule bg-surface px-3 py-5 shadow-panel lg:flex">
      <Link href="/" className="flex items-center gap-2.5 rounded-md px-2.5">
        <BrandMark className="size-7" />
        <span className="flex flex-col leading-tight">
          <span className="font-semibold text-ink">{BRAND.name}</span>
          <span className="text-xs text-muted">{BRAND.tagline}</span>
        </span>
      </Link>

      <nav aria-label="주 메뉴" className="flex flex-col gap-5">
        {navGroupsFor(showSim).map((group) => (
          <div key={group.id} className="flex flex-col gap-1.5">
            <p id={`nav-group-${group.id}`} className="px-2.5 font-mono text-[11px] tracking-wider text-muted">
              {group.label}
            </p>
            <ul aria-labelledby={`nav-group-${group.id}`} className="flex flex-col gap-0.5">
              {group.items.map(({ href, label, icon: Icon }) => (
                <li key={href}>
                  <NavLink href={href} className={LINK_CLASS}>
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
