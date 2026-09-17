import { Info } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { DeliveryCsvImport, DeliveryManualForm } from '@/components/settings/supply-forms';
import { buttonClass, CONTROL_CLASS } from '@/components/ui/form-styles';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { DELIVERY_LIST_LIMIT, listDeliveries, listDeliverySites, summarizeRecentDeliveries } from '@/lib/data/h2-delivery';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime, formatNumber } from '@/lib/format';

export const metadata: Metadata = { title: '수소 반입' };

const SOURCE_LABELS: Readonly<Record<string, string>> = { manual: '직접 입력', csv: 'CSV' };
const SUMMARY_DAYS = 30;
const DAY_MS = 86_400_000;

/** datetime-local 기본값 (KST 분 단위) */
const kstLocalInput = (ms: number): string => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16);

type SupplyPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function SupplySettingsPage({ searchParams }: SupplyPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const nowMs = requestTimeMs();
  const sites = await listDeliverySites();
  const siteCode = sites.find((s) => s.code === firstParam(query.site))?.code ?? null;
  const [list, summary] = await Promise.all([listDeliveries(siteCode), summarizeRecentDeliveries(nowMs - SUMMARY_DAYS * DAY_MS)]);

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/supply" />

      <p className="flex items-start gap-2 rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        수소 원장의 잔차는 <span className="mx-1 font-mono">생산 + 반입 − 연료전지 소비 − 재고 변화 − 배출 추정</span>입니다. 하역 적산계(h2.delivery.mass.total)가 있으면 그 값을 먼저 쓰고, 없으면 여기 기록한 전표 값을 씁니다. 반입 설비가 등록된 사이트에서{' '}
        <strong>계량도 기록도 없는 날은 0으로 채우지 않고 판정 불능</strong>으로 둡니다 — 반입분을 손실로 오인해 물질수지 경보가 상시 울리는 것을 막기 위해서입니다.
      </p>

      <Panel title={`최근 ${SUMMARY_DAYS}일 반입 요약`} meta="사이트별 기록 일수·합계 — 원장 delivered 항이 실제로 채워지는지 확인">
        {summary.length === 0 ? (
          <EmptyNote>최근 {SUMMARY_DAYS}일 반입 기록이 없습니다</EmptyNote>
        ) : (
          <TableScroll label="사이트별 반입 요약 표">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>사이트</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>기록 일수</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>합계 (kg)</th>
                  <th scope="col" className={TH_CLASS}>마지막 하역</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.siteCode}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.siteCode}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.days, 0)}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.totalKg, 1)}</td>
                    <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(row.lastDeliveredAtMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Panel title="반입 기록 직접 입력" meta="하역 1건 = 1행 · 저장하면 다음 분석 실행에서 원장에 반영됩니다">
        {sites.length === 0 ? <EmptyNote>등록된 사이트가 없습니다</EmptyNote> : <DeliveryManualForm sites={sites} defaultDeliveredAt={kstLocalInput(nowMs)} />}
      </Panel>

      <Panel title="CSV 가져오기" meta="미리보기에서 오류가 없을 때만 가져올 수 있습니다">
        <DeliveryCsvImport />
      </Panel>

      <Panel title="반입 기록" meta={`하역 일시 최근 순${list.truncated ? ` · 최근 ${DELIVERY_LIST_LIMIT}건` : ''}`}>
        <form method="get" action="/settings/supply" className="flex flex-wrap items-end gap-3" aria-label="반입 기록 필터">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            사이트
            <select name="site" defaultValue={siteCode ?? ''} className={`${CONTROL_CLASS} min-w-32`}>
              <option value="">전체</option>
              {sites.map((s) => (
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
        {list.rows.length === 0 ? (
          <EmptyNote>반입 기록이 없습니다</EmptyNote>
        ) : (
          <TableScroll label="반입 기록 표" stickyFirst>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>사이트</th>
                  <th scope="col" className={TH_CLASS}>하역 일시</th>
                  <th scope="col" className={TH_CLASS}>공급사 · 차량</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>반입량 (kg)</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>잔량 (kg)</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>단가 (원/kg)</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>순도 (%)</th>
                  <th scope="col" className={TH_CLASS}>출처 · 입력자</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.siteCode}</td>
                    <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(row.deliveredAtMs)}</td>
                    <td className={TD_CLASS}>
                      {row.supplier}
                      {row.vehicleNo ? <span className="block font-mono text-xs text-muted">{row.vehicleNo}</span> : null}
                    </td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.massKg, 2)}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.heelMassKg === null ? '—' : formatNumber(row.heelMassKg, 2)}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.unitPriceKrw === null ? '—' : formatNumber(row.unitPriceKrw, 0)}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.purityPct === null ? '—' : formatNumber(row.purityPct, 3)}</td>
                    <td className={`${TD_CLASS} text-xs text-ink-2`}>
                      {SOURCE_LABELS[row.source] ?? row.source}
                      <span className="block font-mono text-muted">{row.createdBy}</span>
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
