'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '@/lib/brand';
import { BrandMark } from './brand-mark';
import { navGroupsFor } from './nav-items';
import { NavLink } from './nav-link';

const PANEL_ID = 'console-nav-drawer';
const FOCUSABLE = 'a[href], button:not([disabled])';

const LINK_CLASS =
  'flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink ' +
  'aria-[current=page]:bg-hydrogen-fill aria-[current=page]:font-medium aria-[current=page]:text-ink ' +
  'aria-[current=page]:shadow-[inset_3px_0_0_var(--accent),0_0_16px_-8px_var(--accent)]';

/**
 * lg 미만에서 사이드바를 대신하는 서랍 메뉴 (lg 이상에서는 아예 렌더되지 않는다).
 * 바깥 클릭·ESC·화면 이동으로 닫고, 열려 있는 동안 포커스를 서랍 안에 가둔다.
 */
export function MobileNav({ showSim }: Readonly<{ showSim: boolean }>) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  // 화면이 바뀌면 닫는다. 포커스는 건드리지 않는다 — 이동 뒤 포커스는 라우터가 정한다.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const targets = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first || !last) return;
      const edge = event.shiftKey ? first : last;
      if (document.activeElement !== edge) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };

    document.addEventListener('keydown', onKeyDown);
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  return (
    <div className="lg:hidden">
      <button
        ref={toggleRef}
        type="button"
        aria-label="메뉴"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((current) => !current)}
        className="flex size-11 shrink-0 items-center justify-center rounded-md border border-rule-strong bg-sunken text-ink-2 hover:bg-rule hover:text-ink"
      >
        <Menu aria-hidden="true" className="size-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex">
          {/* 바깥 어둡게. 키보드에는 ESC와 닫기 버튼이 있으므로 이 면은 보조기술에서 숨긴다 */}
          <div aria-hidden="true" onClick={close} className="absolute inset-0 bg-ground/80 backdrop-blur-sm" />
          <div
            ref={panelRef}
            id={PANEL_ID}
            role="dialog"
            aria-modal="true"
            aria-label="메뉴"
            className="relative flex w-72 max-w-[85vw] flex-col gap-6 overflow-y-auto border-r border-rule bg-surface px-3 py-4 shadow-panel"
          >
            <div className="flex items-center justify-between gap-2">
              <Link href="/" className="flex min-h-11 items-center gap-2.5 rounded-md px-2.5 font-semibold text-ink">
                <BrandMark className="size-7" />
                <span className="flex flex-col leading-tight">
                  <span>{BRAND.name}</span>
                  <span className="text-xs font-normal text-muted">{BRAND.tagline}</span>
                </span>
              </Link>
              <button
                type="button"
                onClick={close}
                aria-label="메뉴 닫기"
                className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>

            <nav aria-label="주 메뉴" className="flex flex-col gap-5">
              {navGroupsFor(showSim).map((group) => (
                <div key={group.id} className="flex flex-col gap-1.5">
                  <p id={`drawer-nav-group-${group.id}`} className="px-2.5 font-mono text-[11px] tracking-wider text-muted">
                    {group.label}
                  </p>
                  <ul aria-labelledby={`drawer-nav-group-${group.id}`} className="flex flex-col gap-0.5">
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
        </div>
      )}
    </div>
  );
}
