import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { ActionForm } from '@/components/desk/action-form';
import { ActivityTimeline } from '@/components/desk/activity-timeline';
import { ChecksTable, PlaybookDetails } from '@/components/desk/checks-panel';
import { EffectCard } from '@/components/desk/effect-card';
import { EvidenceCanvas } from '@/components/desk/evidence-canvas';
import { FindingHeader } from '@/components/desk/finding-header';
import { RawSeriesPanel } from '@/components/desk/raw-series-panel';
import { EmptyNote, Panel } from '@/components/ui/panel';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import { requireAdmin } from '@/lib/auth/dal';
import { defaultSeriesSpan, getFindingSeries, isSeriesSpan } from '@/lib/data/finding-series';
import { getAssetCodes, getFindingDetail, type FindingDetail } from '@/lib/data/finding-workspace';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { isSimConsoleEnabled } from '@/lib/data/sim-console';
import { requestTimeMs } from '@/lib/data/time';
import { expectedEffectDefaults, verificationMetricsFor } from '@/lib/desk/action-defaults';
import { chargeTimeText, convertedChargeTime } from '@/lib/desk/conditions';
import { parseScorecard, trustBadgeFor } from '@/lib/desk/scorecard';
import { buildTimeline } from '@/lib/desk/timeline';

export const metadata: Metadata = { title: '발견사항 워크스페이스' };

const BIGINT_ID = /^[1-9]\d{0,17}$/;

type FindingPageProps = Readonly<{
  params: Promise<{ findingId: string }>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}>;

function chargeTimeOf(finding: FindingDetail): string | null {
  if (finding.evidence.kind !== 'capacity') return null;
  const comparison = convertedChargeTime(finding.effect.baseline, finding.effect.current, finding.evidence.referenceCurrentA);
  return comparison ? chargeTimeText(comparison) : null;
}

function ActionPanel({ finding }: Readonly<{ finding: FindingDetail }>) {
  const playbook = finding.failureMode ? PLAYBOOKS[finding.failureMode] : null;
  const closed = finding.status === 'dismissed' || finding.status === 'verified';
  return (
    <Panel title="권고 조치 작성" meta="정비 조치를 기록하면 발견사항은 조치 완료가 됩니다">
      {finding.asset === null ? (
        <EmptyNote>사이트 단위 발견사항에는 설비 조치를 기록할 수 없습니다</EmptyNote>
      ) : closed ? (
        <EmptyNote>기각되었거나 효과가 확인된 발견사항입니다. 조치를 기록하려면 먼저 다시 여세요.</EmptyNote>
      ) : (
        <>
          {playbook && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2" aria-label="플레이북 권고 조치">
              {playbook.actions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <ActionForm findingId={finding.id} suggestions={playbook?.actions ?? []} metrics={verificationMetricsFor(finding.asset.classKey)} defaults={expectedEffectDefaults(finding.detectorId, finding.effect)} />
        </>
      )}
    </Panel>
  );
}

export default async function FindingPage({ params, searchParams }: FindingPageProps) {
  await requireAdmin();
  const [{ findingId }, query] = await Promise.all([params, searchParams]);
  if (!BIGINT_ID.test(findingId)) notFound();
  const finding = await getFindingDetail(findingId);
  if (!finding) notFound();

  const nowMs = requestTimeMs();
  const spanParam = firstParam(query.series);
  const span = isSeriesSpan(spanParam) ? spanParam : defaultSeriesSpan(finding.detectorId);
  const { evidence } = finding;
  const [series, peerCodes] = await Promise.all([
    getFindingSeries({ detectorId: finding.detectorId, assetId: finding.asset?.id ?? null, windowEndMs: finding.windowEndMs, evidence }, span, nowMs),
    getAssetCodes(evidence.kind === 'cell_imbalance' ? evidence.peers.values.map((peer) => peer.assetId) : []),
  ]);
  const playbook = finding.failureMode ? PLAYBOOKS[finding.failureMode] : null;
  const checks = evidence.kind === 'capacity' || evidence.kind === 'stack' ? evidence.checks : [];
  const chargeTime = chargeTimeOf(finding);
  const assetLabel = finding.asset ? finding.asset.code : finding.siteCode;
  const basePath = `/desk/${finding.id}`;

  return (
    <>
      <Breadcrumb items={[{ label: '분석 데스크', href: '/desk' }, { label: `발견사항 #${finding.id}` }]} />
      <FindingHeader finding={finding} badge={trustBadgeFor(parseScorecard(scorecardJson), finding.detectorId)} simEnabled={isSimConsoleEnabled()} />
      <EffectCard finding={finding} chargeTimeText={chargeTime} />
      <EvidenceCanvas evidence={evidence} chargeTimeText={chargeTime} assetLabel={assetLabel} peerCodes={peerCodes} />
      <section id="raw-series" className="scroll-mt-20">
        <RawSeriesPanel series={series} span={span} basePath={basePath} exploreHref={finding.asset ? `/sites/${encodeURIComponent(finding.siteCode)}/assets/${finding.asset.id}` : null} />
      </section>
      <Panel title="원인 후보 판별" meta={playbook ? playbook.title : undefined}>
        <ChecksTable checks={checks} />
        {playbook && <PlaybookDetails playbook={playbook} />}
      </Panel>
      <ActionPanel finding={finding} />
      <Panel title="활동 타임라인" meta="상태 전이 · 근거 갱신 · 조치 · 효과 검증">
        <ActivityTimeline entries={buildTimeline(finding, nowMs)} />
      </Panel>
    </>
  );
}
