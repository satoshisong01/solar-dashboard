import { ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { SITE_LAYOUT_LABELS, listSites } from '@/lib/data/sites';
import { requestTimeMs } from '@/lib/data/time';
import { formatAgo } from '@/lib/format';

export const metadata: Metadata = { title: '사이트' };

export default async function SitesPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const sites = await listSites();

  return (
    <>
      <PageHeader title="사이트" purpose="사이트 맥락: 설비 트리, KPI, 타임라인, 에너지·수소 체인" guide={SCREEN_GUIDES.sites} />
      <Panel title="사이트 목록" meta={`${sites.length}곳`}>
        {sites.length === 0 ? (
          <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
        ) : (
          <TableScroll label="사이트 목록 표">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>사이트</th>
                  <th scope="col" className={TH_CLASS}>구성</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>설비</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>포인트</th>
                  <th scope="col" className={TH_CLASS}>게이트웨이 마지막 수신</th>
                  <th scope="col" className={TH_CLASS}>미확인 안전 이벤트</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.id}>
                    <th scope="row" className={`${TD_CLASS} font-medium`}>
                      <Link href={`/sites/${encodeURIComponent(site.code)}`} className="text-ink hover:underline">{site.code}</Link>
                      <span className="block text-xs font-normal text-muted">{site.name}</span>
                    </th>
                    <td className={`${TD_CLASS} text-ink-2`}>
                      {(site.layout && SITE_LAYOUT_LABELS[site.layout]) ?? site.layout ?? '—'}
                      <span className="block text-xs text-muted">
                        {[site.simulated ? '가상 사이트' : null, site.controlGroup ? '대조군' : null].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{site.assetCount}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{site.pointCount}</td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                      {site.gatewayCount === 0 ? '게이트웨이 없음' : site.lastSeenMs === null ? '수신 기록 없음' : formatAgo(site.lastSeenMs, nowMs)}
                    </td>
                    <td className={TD_CLASS}>
                      {site.unackedSafety > 0 ? (
                        <span className="inline-flex items-center gap-1 font-medium text-crit">
                          <ShieldAlert aria-hidden="true" className="size-4" />
                          {site.unackedSafety}건
                        </span>
                      ) : (
                        <span className="text-muted">없음</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </>
  );
}
