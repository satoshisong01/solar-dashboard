import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { GLOSSARY } from '@/lib/desk/plain/glossary';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';

export const metadata: Metadata = { title: '용어집' };

export default async function HelpPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="용어집" purpose="콘솔과 리포트에 나오는 말을 쉬운 말과 비유로" guide={SCREEN_GUIDES.help} />

      <Panel title="목차" meta={`${GLOSSARY.length}개`}>
        <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
          {GLOSSARY.map((entry) => (
            <li key={entry.id}>
              <a href={`#${entry.id}`} className="text-accent hover:underline">
                {entry.term}
              </a>
            </li>
          ))}
        </ul>
      </Panel>

      <dl className="flex flex-col gap-4">
        {GLOSSARY.map((entry) => (
          <div key={entry.id} id={entry.id} className="flex scroll-mt-20 min-w-0 flex-col gap-1.5 rounded-lg border border-rule bg-surface p-4 md:p-5">
            <dt className="text-base font-semibold text-ink">{entry.term}</dt>
            <dd className="flex flex-col gap-1.5">
              <p className="text-pretty text-ink-2">{entry.plain}</p>
              <p className="rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-pretty text-ink-2">
                <span className="mr-1.5 text-xs text-muted">예</span>
                {entry.example}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
