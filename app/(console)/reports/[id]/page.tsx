import { Printer } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { buttonClass } from '@/components/ui/form-styles';
import { BlockCard } from '@/components/reports/block-card';
import { KpiTable, PackFindingsTable, PackProvenance, ValidationSummary } from '@/components/reports/pack-panels';
import { ReportStatusBadge } from '@/components/reports/report-badges';
import { ApproveForm, RegenerateForm } from '@/components/reports/review-controls';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { getReportDetail, type ReportDetail } from '@/lib/data/reports';
import { formatKstDateTime } from '@/lib/format';
import { citationChip, reportStatusLabel } from '@/lib/report/citations';

export const metadata: Metadata = { title: '리포트 검토' };

const BIGINT_ID = /^[1-9]\d{0,17}$/;

type ReportPageProps = Readonly<{ params: Promise<{ id: string }>; searchParams: Promise<Record<string, SearchParamValue>> }>;

const countParam = (value: string | undefined): number | null => (value !== undefined && /^\d{1,4}$/.test(value) ? Number(value) : null);

function ReportMeta({ report }: Readonly<{ report: ReportDetail }>) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <dt className="text-xs text-muted">사이트</dt>
        <dd className="text-ink">
          {report.siteCode} · {report.siteName}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">기간</dt>
        <dd className="text-ink">{report.pack?.period.label ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">작성</dt>
        <dd className="text-ink-2">
          {report.createdBy} · <span className="font-mono text-xs">{formatKstDateTime(report.createdAtMs)}</span>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">승인</dt>
        <dd className="text-ink-2">{report.approvedBy && report.approvedAtMs !== null ? `${report.approvedBy} · ${formatKstDateTime(report.approvedAtMs)}` : '—'}</dd>
      </div>
    </dl>
  );
}

function Chain({ report }: Readonly<{ report: ReportDetail }>) {
  if (report.chain.length <= 1) return <p className="text-sm text-muted">같은 사이트·기간의 다른 리포트가 없습니다.</p>;
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {report.chain.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-2">
          {item.id === report.id ? <span className="font-mono font-medium">#{item.id} (이 리포트)</span> : <Link href={`/reports/${item.id}`} className="font-mono underline">#{item.id}</Link>}
          <ReportStatusBadge status={item.status} />
          <span className="font-mono text-xs text-muted">{formatKstDateTime(item.createdAtMs)}</span>
        </li>
      ))}
    </ol>
  );
}

export default async function ReportPage({ params, searchParams }: ReportPageProps) {
  await requireAdmin();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const approvedMoved = countParam(firstParam(query.approved));
  const superseded = countParam(firstParam(query.superseded));
  if (!BIGINT_ID.test(id)) notFound();
  const report = await getReportDetail(id);
  if (!report) notFound();
  const { draft, pack, validation } = report;
  const editable = report.status === 'draft';
  const issuesOf = (blockId: string) => validation.issues.filter((i) => i.blockId === blockId).map((i) => i.message);

  return (
    <>
      <Breadcrumb items={[{ label: '코칭 리포트', href: '/reports' }, { label: `리포트 #${report.id}` }]} />
      <Panel
        title={draft?.title ?? `리포트 #${report.id}`}
        meta={`${report.composerId} · 팩 ${report.packHash.slice(0, 12)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ReportStatusBadge status={report.status} />
            <Link href={`/reports/${report.id}/print`} className={buttonClass('secondary')}>
              <Printer aria-hidden="true" className="size-4" />
              인쇄 화면 (PDF 출력)
            </Link>
          </div>
        }
      >
        {approvedMoved !== null && report.status === 'approved' && (
          <p role="status" className="rounded-md border border-ok/40 bg-ok-fill px-3 py-2 text-sm text-ok">
            승인했습니다. 발견사항 {approvedMoved}건을 리포트 반영으로 옮겼습니다.{superseded ? ` 같은 기간의 이전 리포트 ${superseded}건은 대체됨으로 바꿨습니다.` : ''} 인쇄 화면에서 PDF로 출력하세요.
          </p>
        )}
        <ReportMeta report={report} />
        {report.pack?.selection.basedOnReportId && (
          <p className="text-sm text-ink-2">
            <Link href={`/reports/${report.pack.selection.basedOnReportId}`} className="font-mono underline">
              리포트 #{report.pack.selection.basedOnReportId}
            </Link>
            에서 &lsquo;새 초안 만들기&rsquo;로 만든 리포트입니다.
          </p>
        )}
        {editable ? <ApproveForm reportId={report.id} validationOk={validation.ok} /> : <RegenerateForm reportId={report.id} />}
        {report.status === 'superseded' && <p className="text-sm text-warn">같은 기간의 더 새로운 리포트가 승인되어 대체된 리포트입니다.</p>}
      </Panel>

      <Panel title="검증기 결과" meta="validateDraft">
        <ValidationSummary validation={validation} />
      </Panel>

      {draft === null || pack === null ? (
        <EmptyNote>저장된 리포트 형식을 읽을 수 없습니다. 새 리포트를 만드세요.</EmptyNote>
      ) : (
        draft.sections.map((section) => (
          <Panel key={section.kind} title={section.title} meta={editable ? '문장 편집 · 포함/제외' : reportStatusLabel(report.status)}>
            <div className="flex flex-col gap-2">
              {section.blocks.map((block) => (
                <BlockCard key={block.id} reportId={report.id} block={block} editable={editable && !block.locked} citations={block.citations.map((c) => citationChip(c, pack))} issues={issuesOf(block.id)} />
              ))}
            </div>
          </Panel>
        ))
      )}

      {pack && (
        <>
          <Panel title="근거 팩 · 발견사항" meta={`판정·우선순위는 결정적 엔진(${pack.provenance.engineVersion})이 정합니다`}>
            <PackFindingsTable pack={pack} />
          </Panel>
          <Panel title="근거 팩 · KPI" meta="om.kpi_daily 기간 요약">
            <KpiTable pack={pack} />
          </Panel>
          <Panel title="근거 팩 · 출처">
            <PackProvenance pack={pack} />
          </Panel>
        </>
      )}

      <Panel title="같은 사이트·기간 리포트" meta="새 초안을 승인하면 이전 리포트는 대체됨">
        <Chain report={report} />
      </Panel>
    </>
  );
}
