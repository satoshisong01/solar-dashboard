import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { MarketCsvUpload, MarketManualForm } from '@/components/settings/market-forms';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { listRecentMarketEntries } from '@/lib/data/market';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';

export const metadata: Metadata = { title: '시장가격' };

const RECENT_LIMIT = 60;
const SOURCE_LABELS: Readonly<Record<string, string>> = { manual: '수기', csv: 'CSV' };

export default async function MarketSettingsPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const entries = await listRecentMarketEntries(RECENT_LIMIT);

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/market" />

      <Panel title="수기 입력" meta="SMP(육지·제주)·REC 일별 값 → 오늘 화면 수익 요약">
        <MarketManualForm defaultDay={formatKstDate(nowMs)} />
      </Panel>

      <Panel title="CSV 업로드" meta="미리보기에서 오류가 없을 때만 적용할 수 있습니다">
        <MarketCsvUpload />
      </Panel>

      <Panel title="입력 기록" meta={`최근 날짜부터 ${RECENT_LIMIT}건`}>
        {entries.length === 0 ? (
          <EmptyNote>입력된 SMP·REC 값이 없습니다</EmptyNote>
        ) : (
          <TableScroll label="시장가격 입력 기록 표">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>날짜</th>
                  <th scope="col" className={TH_CLASS}>항목</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>값</th>
                  <th scope="col" className={TH_CLASS}>출처</th>
                  <th scope="col" className={TH_CLASS}>입력자 · 시각</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={`${entry.day}|${entry.marketKey}`}>
                    <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{entry.day}</td>
                    <td className={TD_CLASS}>{entry.label}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                      {formatNumber(entry.value, 4)} <span className="text-xs text-muted">{entry.unit}</span>
                    </td>
                    <td className={`${TD_CLASS} text-ink-2`}>{SOURCE_LABELS[entry.source] ?? entry.source}</td>
                    <td className={`${TD_CLASS} text-xs text-ink-2`}>
                      {entry.updatedBy ?? '—'}
                      <span className="block font-mono text-muted">{formatKstDateTime(entry.updatedAtMs)}</span>
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
