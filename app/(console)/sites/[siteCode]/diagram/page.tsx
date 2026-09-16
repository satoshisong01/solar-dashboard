import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { DiagramAssetTable, DiagramTagTable, FlowLegend, OffDiagramFindings } from '@/components/diagram/diagram-panels';
import { ProcessDiagram } from '@/components/diagram/process-diagram';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { decodeRouteParam } from '@/lib/data/range';
import { getSiteDiagram } from '@/lib/data/site-diagram';
import { requestTimeMs } from '@/lib/data/time';
import { DRAWING } from '@/lib/diagram/gapyeong-layout';
import { formatAgo, formatKstDateTime } from '@/lib/format';

type DiagramPageProps = Readonly<{ params: Promise<{ siteCode: string }> }>;

export async function generateMetadata({ params }: DiagramPageProps): Promise<Metadata> {
  const { siteCode } = await params;
  return { title: `${decodeRouteParam(siteCode) ?? '사이트'} 공정도` };
}

export default async function SiteDiagramPage({ params }: DiagramPageProps) {
  await requireAdmin();
  const { siteCode } = await params;
  const code = decodeRouteParam(siteCode);
  const nowMs = requestTimeMs();
  const diagram = code === null ? null : await getSiteDiagram(code, nowMs);
  if (!diagram) notFound();
  const { site, view } = diagram;
  const drawnCount = view.nodes.filter((node) => node.asset !== null).length;

  return (
    <>
      <Breadcrumb
        items={[
          { label: '사이트', href: '/sites' },
          { label: site.code, href: `/sites/${encodeURIComponent(site.code)}` },
          { label: '공정도' },
        ]}
      />
      <PageHeader
        title={`${site.code} · 공정도`}
        purpose={`${DRAWING.number} ${DRAWING.revision} (${DRAWING.date}) · ${DRAWING.title}`}
      />

      {!view.available ? (
        <Panel title="공정도 없음">
          <EmptyNote>
            이 도면은 수소 계통 공정도입니다. {site.code}에는 수전해 설비가 없어 그릴 수 있는 계통이 없습니다.{' '}
            <Link href={`/sites/${encodeURIComponent(site.code)}`} className="underline">
              사이트 상세
            </Link>
            에서 설비 트리를 보세요.
          </EmptyNote>
        </Panel>
      ) : (
        <>
          <Panel
            title="공정흐름 · 계장도"
            meta={
              view.lastSampleMs === null
                ? '수신 기록 없음 · 값 자리는 모두 데이터 없음으로 둡니다'
                : `값 갱신 ${formatKstDateTime(view.lastSampleMs)} (${formatAgo(view.lastSampleMs, nowMs)}) · 기준 ${formatKstDateTime(nowMs)}`
            }
            action={
              <span className="text-xs text-muted">
                도면 설비 {drawnCount} / {view.nodes.length}개
              </span>
            }
          >
            <div
              role="region"
              aria-label="공정도 그림 (가로로 넘어가면 스크롤됩니다)"
              tabIndex={0}
              className="-mx-4 overflow-x-auto px-4 md:-mx-5 md:px-5"
            >
              <ProcessDiagram view={view} label={`${site.code} ${site.name} 공정흐름 계장도`} />
            </div>
            <FlowLegend />
            <p className="text-xs text-muted">
              흐름선은 물질 종류만 나타냅니다. 상태는 설비 상자의 테두리와 배지로만 나타냅니다 — 바로 확인(빨강) · 주의(주황). 값은 계측
              포인트의 최근 원시값이고, 계산값(SEC·UA·회수율)은 이 화면에 올리지 않습니다. 설비 상자를 누르면 열린 발견사항이나 설비
              상세로 갑니다.
            </p>
          </Panel>

          <Panel title="설비 목록" meta="좁은 화면에서 그림을 대신하는 표입니다">
            <DiagramAssetTable view={view} nowMs={nowMs} />
          </Panel>

          <Panel title="계장 태그" meta={`도면 계장 ${view.tags.length}점`}>
            <DiagramTagTable view={view} nowMs={nowMs} />
          </Panel>

          {view.offDiagramFindings.length > 0 && (
            <Panel title="공정도에 없는 열린 발견사항" meta={`${view.offDiagramFindings.length}건`}>
              <OffDiagramFindings view={view} />
            </Panel>
          )}
        </>
      )}
    </>
  );
}
