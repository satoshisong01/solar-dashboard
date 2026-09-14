import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { CreateGatewayForm, IssueKeyForm, RevokeKeyForm } from '@/components/settings/gateway-forms';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { listGatewaysWithKeys, listSiteOptions, type GatewayWithKeys } from '@/lib/data/gateways';
import { requestTimeMs } from '@/lib/data/time';
import { formatAgo, formatKstDateTime } from '@/lib/format';
import { MAX_ACTIVE_GATEWAY_KEYS } from '@/lib/ops/gateways';

export const metadata: Metadata = { title: '게이트웨이·키' };

function GatewayCard({ gateway, nowMs }: Readonly<{ gateway: GatewayWithKeys; nowMs: number }>) {
  const active = gateway.keys.filter((key) => key.revokedAtMs === null).length;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-rule p-3 md:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-base font-semibold text-ink">{gateway.code}</span>
          <span className="text-sm text-ink-2">{gateway.siteCode}</span>
          {gateway.status !== 'active' && <span className="text-xs text-muted">비활성</span>}
        </h3>
        <p className="text-xs text-muted">
          마지막 수신 {gateway.lastSeenMs === null ? '기록 없음' : `${formatKstDateTime(gateway.lastSeenMs)} (${formatAgo(gateway.lastSeenMs, nowMs)})`} · 활성 키 {active}/{MAX_ACTIVE_GATEWAY_KEYS}
        </p>
      </div>
      {gateway.keys.length === 0 ? (
        <p className="text-sm text-warn">발급된 키가 없어 이 게이트웨이의 수집 요청은 모두 401입니다.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule rounded-md border border-rule">
          {gateway.keys.map((key) => (
            <li key={key.keyId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="font-mono text-sm break-all text-ink">{key.keyId}</p>
                <p className="text-xs text-muted">
                  발급 {formatKstDateTime(key.createdAtMs)}
                  {key.revokedAtMs !== null && ` · 폐기 ${formatKstDateTime(key.revokedAtMs)}`}
                </p>
              </div>
              {key.revokedAtMs === null ? <RevokeKeyForm keyId={key.keyId} /> : <span className="text-xs text-muted">폐기됨</span>}
            </li>
          ))}
        </ul>
      )}
      <IssueKeyForm gatewayId={gateway.id} canIssue={active < MAX_ACTIVE_GATEWAY_KEYS} />
    </li>
  );
}

export default async function GatewaySettingsPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const [gateways, sites] = await Promise.all([listGatewaysWithKeys(), listSiteOptions()]);

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/gateways" />

      <Panel title="게이트웨이 만들기">
        {sites.length === 0 ? <EmptyNote>사이트가 없어 게이트웨이를 만들 수 없습니다</EmptyNote> : <CreateGatewayForm sites={sites} />}
      </Panel>

      <Panel title="게이트웨이·HMAC 키" meta={`${gateways.length}개 · 게이트웨이당 활성 키 ${MAX_ACTIVE_GATEWAY_KEYS}개로 무중단 회전 (새 키 발급 → 게이트웨이 교체 → 이전 키 폐기)`}>
        {gateways.length === 0 ? (
          <EmptyNote>등록된 게이트웨이가 없습니다</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-3">
            {gateways.map((gateway) => (
              <GatewayCard key={gateway.id} gateway={gateway} nowMs={nowMs} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
