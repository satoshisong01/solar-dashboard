import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { CreateReportForm } from '@/components/reports/create-report-form';
import { ReportList } from '@/components/reports/report-list';
import { ReportScopeForm, type ScopeDefaults } from '@/components/reports/report-scope-form';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { listReportCandidates, listReports, listReportSites, REPORT_LIST_LIMIT } from '@/lib/data/reports';
import { requestTimeMs } from '@/lib/data/time';
import { periodSpecOf } from '@/lib/forms/reports';
import type { ReportPeriodKind } from '@/lib/report/pack-types';
import { currentMonth, currentQuarter, kstDay, resolveReportPeriod } from '@/lib/report/period';

export const metadata: Metadata = { title: '코칭 리포트' };

type ReportsPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

const KINDS: readonly ReportPeriodKind[] = ['month', 'quarter', 'custom'];

// 설계 §0: 분석과 출력 분리 — 리포트는 이 화면의 "리포트 만들기"로만 만든다. 메일 발송 없음, PDF는 인쇄 화면에서.
export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const nowMs = requestTimeMs();
  const params = Object.fromEntries(['site', 'kind', 'month', 'year', 'quarter', 'from', 'to', 'list'].map((key) => [key, firstParam(query[key])]));
  const quarter = currentQuarter(nowMs);
  const kind = KINDS.find((k) => k === params.kind) ?? 'month';
  const defaults: ScopeDefaults = { site: params.site ?? '', kind, month: params.month ?? currentMonth(nowMs), year: params.year ?? String(quarter.year), quarter: params.quarter ?? String(quarter.quarter), from: params.from ?? `${currentMonth(nowMs)}-01`, to: params.to ?? kstDay(nowMs) };

  const [sites, reports] = await Promise.all([listReportSites(), listReports(null)]);
  const site = sites.find((s) => s.code === params.site) ?? null;
  const spec = params.kind ? periodSpecOf(params) : null;
  const period = spec ? resolveReportPeriod(spec) : null;
  const candidates = site && period?.ok ? await listReportCandidates(site.id, period.period) : null;
  const scope = Object.fromEntries(Object.entries({ kind, month: params.month, year: params.year, quarter: params.quarter, from: params.from, to: params.to }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

  return (
    <>
      <PageHeader title="코칭 리포트" purpose="사이트별 리포트 초안을 만들고 검토·승인한 뒤 PDF로 출력" />

      <Panel title="리포트 만들기" meta="분석 실행과 별개 · 메일 발송 없음 · PDF는 인쇄 화면에서 출력">
        {sites.length === 0 ? (
          <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
        ) : (
          <div className="flex flex-col gap-4">
            <ReportScopeForm sites={sites} defaults={defaults} />
            {period && !period.ok && (
              <p role="alert" className="text-sm text-crit">
                {period.error}
              </p>
            )}
            {params.site && !site && (
              <p role="alert" className="text-sm text-crit">
                사이트 {params.site}을(를) 찾을 수 없습니다
              </p>
            )}
            {site && period?.ok && candidates && <CreateReportForm key={`${site.code}|${period.period.from}|${period.period.to}`} siteId={site.id} siteCode={site.code} periodLabel={period.period.label} scope={scope} candidates={candidates} />}
          </div>
        )}
      </Panel>

      <Panel title="리포트 목록" meta={`최근 ${REPORT_LIST_LIMIT}건 · 작성 순`}>
        <ReportList reports={reports} />
      </Panel>
    </>
  );
}
