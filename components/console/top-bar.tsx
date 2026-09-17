import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { signOutAction } from '@/lib/auth/actions';
import { BRAND } from '@/lib/brand';
import { BrandMark } from './brand-mark';
import { CurrentTitle } from './current-title';
import { navGroupsFor } from './nav-items';
import { NavLink } from './nav-link';

const TAB_CLASS =
  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm text-ink-2 hover:bg-sunken hover:text-ink ' +
  'aria-[current=page]:bg-hydrogen-fill aria-[current=page]:font-medium aria-[current=page]:text-ink aria-[current=page]:shadow-glow';

export function TopBar({ email, showSim }: Readonly<{ email: string; showSim: boolean }>) {
  return (
    <header className="border-b border-rule bg-surface/85 backdrop-blur-md md:sticky md:top-0 md:z-10">
      <div className="flex h-14 items-center gap-3 px-4 md:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md font-semibold text-ink md:hidden">
          <BrandMark />
          {BRAND.name}
        </Link>
        <div className="hidden min-w-0 md:block">
          <CurrentTitle showSim={showSim} />
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          <p className="min-w-0 truncate font-mono text-xs text-muted" title={email}>
            <span className="sr-only">로그인 계정: </span>
            {email}
          </p>
          <form action={signOutAction} className="shrink-0">
            <Button type="submit" variant="secondary" className="px-2.5 py-1.5">
              <LogOut className="size-4" />
              로그아웃
            </Button>
          </form>
        </div>
      </div>

      {/* md 미만: 사이드바 대신 가로 스크롤 탭. 스크롤은 이 목록 안에서만 생긴다. */}
      <nav aria-label="주 메뉴" className="border-t border-rule md:hidden">
        <ul className="flex items-center gap-1 overflow-x-auto px-4 py-2">
          {navGroupsFor(showSim).flatMap((group, groupIndex) =>
            group.items.map(({ href, label, icon: Icon }, itemIndex) => (
              <li
                key={href}
                className={`shrink-0 ${groupIndex > 0 && itemIndex === 0 ? 'ml-1 border-l border-rule pl-2' : ''}`}
              >
                <NavLink href={href} className={TAB_CLASS}>
                  <Icon className="size-4 shrink-0" />
                  {label}
                </NavLink>
              </li>
            )),
          )}
        </ul>
      </nav>
    </header>
  );
}
