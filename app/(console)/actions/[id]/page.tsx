import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { BeforeAfterChart } from '@/components/maintenance/before-after-chart';
import { ProgressBar, VerificationBadge } from '@/components/maintenance/verification-badge';
import { VerifyOnlyButton } from '@/components/maintenance/verify-only-button';
import { progressOf } from '@/components/maintenance/action-list';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { VERIFICATION_METRICS } from '@/lib/analytics/verification/before-after';
import { isFindingStatus, statusLabel } from '@/lib/analysis/transition-rules';
import { requireAdmin } from '@/lib/auth/dal';
import { getActionDetail, type ActionDetail } from '@/lib/data/maintenance';
import { requestTimeMs } from '@/lib/data/time';
import { formatSigned } from '@/lib/desk/effect';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';
import { pairBins } from '@/lib/maintenance/bin-labels';
import { parseExpectedEffect } from '@/lib/maintenance/progress';

export const metadata: Metadata = { title: '조치 상세' };

const BIGINT_ID = /^[1-9]\d{0,17}$/;

type ActionPageProps = Readonly<{ params: Promise<{ id: string }> }>;

function ActionInfo({ action }: Readonly<{ action: ActionDetail }>) {
  const effect = parseExpectedEffect(action.expectedEffect);
  const spec = effect ? VERIFICATION_METRICS[effect.metric] : undefined;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted">사이트 · 설비</dt>
        <dd className="text-ink">
          {action.siteCode} · <span className="font-mono">{action.assetPath}</span>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">수행 (KST)</dt>
        <dd className="text-ink">
          {formatKstDateTime(action.performedAtMs)}
          {action.performedBy && ` · ${action.performedBy}`}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">연결 발견사항</dt>
        <dd>
          {action.finding ? (
            <Link href={`/desk/${action.finding.id}`} className="text-ink underline">
              #{action.finding.id} {action.finding.title} ({isFindingStatus(action.finding.status) ? statusLabel(action.finding.status) : action.finding.status})
            </Link>
          ) : (
            <span className="text-muted">없음</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">기대 효과</dt>
        <dd className="text-ink-2">{effect ? `${spec?.label ?? effect.metric} ${formatNumber(effect.minDelta, 4)} ${spec?.unit ?? ''} 이상 ${effect.direction === 'decrease' ? '감소' : '증가'} · 안정화 ${effect.stabilizationDays}일 · 비교 창 ${effect.windowDays}일` : '없음 (자동 검증 안 함)'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">기록</dt>
        <dd className="text-ink-2">
          {action.source === 'csv' ? 'CSV 가져오기' : '직접 기록'} · {action.createdBy} · <span className="font-mono text-xs">{formatKstDateTime(action.createdAtMs)}</span>
        </dd>
      </div>
      {action.notes && (
        <div>
          <dt className="text-xs text-muted">메모</dt>
          <dd className="whitespace-pre-line text-ink-2">{action.notes}</dd>
        </div>
      )}
    </dl>
  );
}

function VerificationResult({ action }: Readonly<{ action: ActionDetail }>) {
  const { verification, detail } = action;
  if (!verification || !detail) return <EmptyNote>아직 검증 결과가 없습니다. 후 창이 채워진 뒤 분석을 실행하거나 &lsquo;검증만 실행&rsquo;을 누르세요.</EmptyNote>;
  const unit = verification.unit;
  const digits = unit === 'V' ? 4 : 2;
  const pairs = pairBins(detail.metric, detail.beforeBins, detail.afterBins);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="font-mono text-3xl font-semibold text-ink tabular-nums">
          {formatSigned(verification.effect, digits)} <span className="text-base">{unit}</span>
        </p>
        {verification.ciLow !== null && verification.ciHigh !== null && (
          <p className="font-mono text-sm text-ink-2 tabular-nums">
            95% CI {formatSigned(verification.ciLow, digits)} ~ {formatSigned(verification.ciHigh, digits)}
          </p>
        )}
      </div>
      <p className="text-sm text-ink-2">
        {detail.metricLabel}: 조치 전 {formatKstDate(detail.beforeFrom)} ~ {formatKstDate(detail.beforeTo)} vs 안정화 후 {formatKstDate(detail.afterFrom)} ~ {formatKstDate(detail.afterTo)}, 같은 조건 bin 중앙값 차이(후 − 전)를 후 표본 수로 가중 결합 · 분석 실행 #{detail.runId} · {formatKstDateTime(verification.computedAtMs)} KST
      </p>
      {pairs.length > 0 && <BeforeAfterChart pairs={pairs} unit={unit} metricLabel={detail.metricLabel} />}
      <TableScroll label="조치 전후 bin 통계 표">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>조건 bin</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>전 n</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>전 중앙값</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>후 n</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>후 중앙값</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.key}>
                <td className={TD_CLASS}>{p.label}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{p.beforeN}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(p.beforeMedian, digits + 1)}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{p.afterN}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(p.afterMedian, digits + 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

export default async function ActionPage({ params }: ActionPageProps) {
  await requireAdmin();
  const { id } = await params;
  if (!BIGINT_ID.test(id)) notFound();
  const action = await getActionDetail(id);
  if (!action) notFound();
  const progress = progressOf(action, requestTimeMs());

  return (
    <>
      <Breadcrumb items={[{ label: '조치 추적', href: '/actions' }, { label: `조치 #${action.id}` }]} />
      <Panel title={action.actionType} meta={`조치 #${action.id}`} action={<VerificationBadge progress={progress} />}>
        <ActionInfo action={action} />
        {progress.state !== 'untracked' && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
            <ProgressBar fraction={progress.fraction} label={progress.label} />
            {progress.afterStart !== null && progress.afterEnd !== null && (
              <span>
                after 창 {formatKstDate(progress.afterStart)} ~ {formatKstDate(progress.afterEnd)}
              </span>
            )}
          </div>
        )}
        {progress.state !== 'untracked' && <VerifyOnlyButton actionId={action.id} />}
      </Panel>
      <Panel title="전후 비교" meta="matched_before_after@1 · verdict">
        <VerificationResult action={action} />
      </Panel>
    </>
  );
}
