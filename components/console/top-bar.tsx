import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signOutAction } from '@/lib/auth/actions';
import { CurrentTitle } from './current-title';
import { MobileNav } from './mobile-nav';

export function TopBar({ email, showSim }: Readonly<{ email: string; showSim: boolean }>) {
  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-surface/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 md:px-8">
        {/* lg 미만: 사이드바 대신 서랍 메뉴. lg 이상에서는 렌더되지 않는다 */}
        <MobileNav showSim={showSim} />
        <div className="min-w-0">
          <CurrentTitle showSim={showSim} />
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          <p className="hidden min-w-0 truncate font-mono text-xs text-muted md:block" title={email}>
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
    </header>
  );
}
