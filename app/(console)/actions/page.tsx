import { Info } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { buttonClass, CONTROL_CLASS } from '@/components/ui/form-styles';
import { ActionCsvImport } from '@/components/maintenance/action-csv-import';
import { ActionList, VerificationQueue } from '@/components/maintenance/action-list';
import { DirectActionForm } from '@/components/maintenance/direct-action-form';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { ACTION_LIST_LIMIT, getActionFormOptions, listActions } from '@/lib/data/maintenance';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { requestTimeMs } from '@/lib/data/time';

export const metadata: Metadata = { title: '조치 추적' };

type ActionsPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function ActionsPage({ searchParams }: ActionsPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const nowMs = requestTimeMs();
  const options = await getActionFormOptions();
  const siteCode = options.sites.find((s) => s.code === firstParam(query.site))?.code ?? null;
  const actions = await listActions(siteCode);

  return (
    <>
      <PageHeader title="조치 추적" purpose="권고가 조치와 효과 검증으로 이어지는지 추적" />
      <p className="flex items-start gap-2 rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        조치 효과 검증은 분석 데스크에서 분석을 실행할 때 함께 계산됩니다 (조치 전 창과 안정화 뒤 창을 같은 조건 bin으로 비교). 창이 채워진 조치는 &lsquo;검증만 실행&rsquo;으로 그 설비의 전후 비교만 다시 계산할 수 있으며, 이때는 저장된 에피소드를 그대로 씁니다.
      </p>

      <Panel title="검증 대기 큐" meta="기대 효과가 있고 아직 판정 전 · 안정화 → after 창 → 분석 실행">
        <VerificationQueue rows={actions.rows} nowMs={nowMs} />
      </Panel>

      <section id="action-list" className="scroll-mt-20">
        <Panel title="조치 목록" meta={`수행일 최근 순${actions.truncated ? ` · 최근 ${ACTION_LIST_LIMIT}건` : ''}`}>
          <form method="get" action="/actions" className="flex flex-wrap items-end gap-3" aria-label="조치 필터">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              사이트
              <select name="site" defaultValue={siteCode ?? ''} className={`${CONTROL_CLASS} min-w-32`}>
                <option value="">전체</option>
                {options.sites.map((s) => (
                  <option key={s.id} value={s.code}>
                    {s.code}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass('secondary')}>
              적용
            </button>
          </form>
          <ActionList rows={actions.rows} nowMs={nowMs} />
        </Panel>
      </section>

      <Panel title="조치 직접 등록" meta="설비 선택 · 발견사항 연결(선택) · 기대 효과(선택)">
        {options.sites.length === 0 ? <EmptyNote>등록된 사이트가 없습니다</EmptyNote> : <DirectActionForm options={options} />}
      </Panel>

      <Panel title="CSV 가져오기" meta="미리보기에서 오류가 없을 때만 가져올 수 있습니다">
        <ActionCsvImport />
      </Panel>
    </>
  );
}
