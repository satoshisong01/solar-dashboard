import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { AckHistoryTable, SafetyNotice, SilenceList, UnackedEventList } from '@/components/safety/safety-panels';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getSafetyAckHistory, getSafetySilenceInputs, getUnackedSafetyEvents } from '@/lib/data/safety';
import { findSafetySilence } from '@/lib/data/safety-silence';
import { requestTimeMs } from '@/lib/data/time';
import { getServerEnv } from '@/lib/env';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '안전' };

const UNACKED_LIMIT = 100;
const HISTORY_LIMIT = 50;

export default async function SafetyPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const silenceMinutes = getServerEnv().SAFETY_SILENCE_MINUTES;
  const [unacked, history, silenceInputs] = await Promise.all([
    getUnackedSafetyEvents(UNACKED_LIMIT),
    getSafetyAckHistory(HISTORY_LIMIT),
    getSafetySilenceInputs(),
  ]);
  const gaps = findSafetySilence(silenceInputs.sites, silenceInputs.gateways, nowMs, silenceMinutes * 60_000);

  return (
    <>
      <PageHeader title="안전" purpose="안전 이벤트 즉시 경로와 확인 이력" guide={SCREEN_GUIDES.safety} />
      <SafetyNotice />

      <Panel title="안전감시 공백" meta={`수소·ESS 설비가 있는 사이트의 게이트웨이 무수신 ${silenceMinutes}분 이상 · 기준 ${formatKstDateTime(nowMs)}`}>
        <SilenceList gaps={gaps} nowMs={nowMs} />
      </Panel>

      <Panel
        title="미확인 안전 이벤트"
        meta={`${unacked.total}건${unacked.total > unacked.rows.length ? ` 중 최근 ${unacked.rows.length}건` : ''} · 자동으로 해제되지 않으며 메모와 함께 확인해야 합니다`}
      >
        <UnackedEventList events={unacked.rows} />
      </Panel>

      <Panel title="확인 이력" meta={`최근 ${HISTORY_LIMIT}건`}>
        <AckHistoryTable events={history} />
      </Panel>
    </>
  );
}
