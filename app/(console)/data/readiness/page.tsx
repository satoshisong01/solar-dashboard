import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { DATA_TABS, SectionTabs } from '@/components/console/section-tabs';
import { AcquisitionTable, ReadinessMatrix } from '@/components/data/readiness-tables';
import { buttonClass, CONTROL_CLASS } from '@/components/ui/form-styles';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { readyRatioText } from '@/lib/analytics/readiness';
import { requireAdmin } from '@/lib/auth/dal';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { getSiteReadiness, READINESS_WINDOW_DAYS } from '@/lib/data/readiness';
import { listSites } from '@/lib/data/sites';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '탐지 준비도' };

type ReadinessPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

const csvHref = (siteCode: string, table: 'matrix' | 'acquisition') => `/api/readiness.csv?${new URLSearchParams({ site: siteCode, ...(table === 'acquisition' ? { table } : {}) }).toString()}`;

export default async function ReadinessPage({ searchParams }: ReadinessPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const sites = await listSites();
  const requested = firstParam(query.site);
  const site = sites.find((s) => s.code === requested) ?? sites[0] ?? null;
  const nowMs = requestTimeMs();
  const view = site ? await getSiteReadiness(site, nowMs) : null;

  return (
    <>
      <PageHeader title="데이터" purpose="수집 상태·데이터 품질 관리, 데이터 계약 협의 지원" />
      <SectionTabs label="데이터 하위 화면" tabs={DATA_TABS} current="/data/readiness" />

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-rule bg-surface p-3" aria-label="준비도 사이트 선택">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          사이트
          <select name="site" defaultValue={site?.code ?? ''} className={`${CONTROL_CLASS} min-w-48`}>
            {sites.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass('secondary')}>
          보기
        </button>
      </form>

      {!site || !view ? (
        <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
      ) : (
        <>
          <Panel
            title={`${site.code} 요약`}
            meta={`포인트 ${view.pointCount}개 · 최근 ${READINESS_WINDOW_DAYS}일 완결성 기준 · ${formatKstDateTime(view.nowMs)} 계산`}
            action={
              <div className="flex flex-wrap gap-2">
                <a href={csvHref(site.code, 'matrix')} className={buttonClass('secondary')} download>
                  <Download aria-hidden="true" className="size-4" />
                  CSV 내려받기
                </a>
                <a href={csvHref(site.code, 'acquisition')} className={buttonClass('secondary')} download>
                  <Download aria-hidden="true" className="size-4" />
                  확보 순위 CSV
                </a>
              </div>
            }
          >
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                { label: '준비됨 비율 (해당 없음 제외)', value: readyRatioText(view.summary) },
                { label: '준비됨', value: String(view.summary.ready) },
                { label: '부분 준비', value: String(view.summary.partial) },
                { label: '필수 메트릭 없음', value: String(view.summary.missing) },
                { label: '해당 없음', value: String(view.summary.notApplicable) },
              ].map((item) => (
                <div key={item.label} className="flex flex-col gap-1 rounded-lg border border-rule bg-surface p-3">
                  <dt className="text-xs text-muted">{item.label}</dt>
                  <dd className="font-mono text-lg text-ink tabular-nums">{item.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">
              셀 판정: 필수 메트릭 포인트가 없으면 &lsquo;없음&rsquo;, 있으나 최근 {READINESS_WINDOW_DAYS}일 완결성 90% 미만·포인트 주기가 탐지기 요구보다 김·이력이 최소 기간보다 짧으면 &lsquo;부분&rsquo;.
              설비 행은 분석이 합쳐 쓰는 상위·형제·사이트 기상 설비 포인트까지 봅니다. 사이트 단위 탐지기(태양광 오염·수소 물질수지)는 첫 행에서 판정합니다. 셀에 마우스를 올리면 사유가 보입니다.
            </p>
          </Panel>

          <Panel title="탐지 준비도 매트릭스" meta={`설비 ${view.rows.length - 1}개 + 사이트 행 × 탐지기 ${view.rows[0]?.cells.length ?? 0}종`}>
            <ReadinessMatrix rows={view.rows} />
          </Panel>

          <Panel title="메트릭 확보 순위" meta="이 메트릭 하나만 확보하면 풀리는 (설비 × 탐지기) 조합이 많은 순 · 벤더·게이트웨이 데이터 계약 협의 자료">
            <AcquisitionTable ranking={view.ranking} />
          </Panel>
        </>
      )}
    </>
  );
}
