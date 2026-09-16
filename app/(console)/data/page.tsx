import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { GatewayIngestTable } from '@/components/data/gateway-ingest-table';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { DATA_TABS, SectionTabs } from '@/components/console/section-tabs';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getGatewayIngestStatus, getUnmappedInbox } from '@/lib/data/ingest-status';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '데이터' };

export default async function DataPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const [gateways, inbox] = await Promise.all([getGatewayIngestStatus(nowMs), getUnmappedInbox()]);
  const unmapped = inbox.filter((tag) => tag.mapped === null).length;
  const pending = inbox.length - unmapped;

  return (
    <>
      <PageHeader title="데이터" purpose="수집 상태·데이터 품질 관리, 데이터 계약 협의 지원" guide={SCREEN_GUIDES.data} />
      <SectionTabs label="데이터 하위 화면" tabs={DATA_TABS} current="/data" />

      <Panel
        title="게이트웨이 수집 상태"
        meta={`최근 24시간(수신 시각 기준) · 기준 ${formatKstDateTime(nowMs)}`}
        action={
          <Link href="/data/unmapped" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            미매핑 태그 {unmapped}개{pending > 0 ? ` · 재처리 대기 ${pending}개` : ''}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
      >
        <GatewayIngestTable rows={gateways} nowMs={nowMs} />
        <p className="text-xs text-muted">
          배치는 새로 저장된 배치만 셉니다. 같은 batch_id를 다시 보낸 재전송(중복 배치)과 인증·형식 오류로 거부된 요청은 저장되지 않아 이 표에 나오지 않습니다.
          중복 샘플은 이미 적재된 (포인트, 시각)이고, 거부 샘플은 미래 +5분 초과 등 규칙으로 버린 샘플입니다.
        </p>
      </Panel>
    </>
  );
}
