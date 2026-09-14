import { Sidebar } from '@/components/console/sidebar';
import { TopBar } from '@/components/console/top-bar';
import { requireAdmin } from '@/lib/auth/dal';
import { isSimConsoleEnabled } from '@/lib/data/sim-console';

export default async function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user } = await requireAdmin();
  const showSim = isSimConsoleEnabled();

  return (
    <>
      <a
        href="#main"
        className="sr-only rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
      >
        본문으로 건너뛰기
      </a>
      <div className="md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
        <Sidebar showSim={showSim} />
        <div className="flex min-h-dvh min-w-0 flex-col">
          <TopBar email={user.email} showSim={showSim} />
          <main id="main" className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
