import { BadgeCheck, CircleHelp } from 'lucide-react';
import Link from 'next/link';
import type { FindingDetail } from '@/lib/data/finding-workspace';
import { CATEGORY_LABELS, detectorLabel } from '@/lib/desk/labels';
import type { TrustBadge } from '@/lib/desk/scorecard';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { ConfidenceBar, FindingSeverityChip, FindingStatusBadge } from './finding-badges';
import { TransitionControls } from './transition-controls';

const pct = (value: number | null): string => (value === null ? '—' : `${formatNumber(value * 100, 0)}%`);

/** 탐지기 신뢰 배지 (설계 §4.1): 시뮬레이터 스코어카드의 재현율·최소 탐지 크기·오탐률 */
export function TrustBadgeView({ badge, detectorId, simEnabled }: Readonly<{ badge: TrustBadge; detectorId: string; simEnabled: boolean }>) {
  if (badge.kind === 'none') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-2" aria-label="탐지기 신뢰 배지">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
        <p>
          <span className="font-medium text-ink">탐지기 신뢰: 평가 결과 없음</span>
          {badge.note && <span className="block text-xs text-muted">{badge.note}</span>}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-hydrogen-edge bg-hydrogen-fill px-3 py-2 text-sm text-ink" aria-label="탐지기 신뢰 배지">
      <BadgeCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hydrogen" />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">
          탐지기 신뢰 · {detectorLabel(detectorId)}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-ink-2">
          <span>재현율 {badge.recall === null ? '평가 안 함(주입 없음)' : pct(badge.recall)}</span>
          <span>최소 탐지 크기 {badge.minDetectable ?? '—'}</span>
          <span>
            오탐 {badge.fpPerAssetMonth === null ? '—' : `${formatNumber(badge.fpPerAssetMonth, 3)}건/자산·월`}
            {badge.assetMonths !== null && ` (${formatNumber(badge.assetMonths, 0)} 자산·월)`}
          </span>
          {badge.medianDelayDays !== null && <span>탐지 지연 중앙값 {formatNumber(badge.medianDelayDays, 1)}일</span>}
        </p>
        <p className="text-xs text-muted">
          시뮬레이터 평가 {badge.generatedAt ?? ''} 기준 (현장 데이터 성능이 아닙니다)
          {simEnabled && (
            <>
              {' · '}
              <Link href="/sim" className="underline">
                스코어카드
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

type HeaderProps = Readonly<{ finding: FindingDetail; badge: TrustBadge; simEnabled: boolean }>;

export function FindingHeader({ finding, badge, simEnabled }: HeaderProps) {
  const assetHref = finding.asset ? `/sites/${encodeURIComponent(finding.siteCode)}/assets/${finding.asset.id}` : null;
  return (
    <header className="flex flex-col gap-3 border-b border-rule pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <FindingSeverityChip severity={finding.severity} />
        <ConfidenceBar confidence={finding.confidence} />
        <FindingStatusBadge status={finding.status} />
        <span className="text-xs text-ink-2">{CATEGORY_LABELS[finding.category]}</span>
        <span className="font-mono text-xs text-muted">
          {finding.detectorId}@{finding.detectorVersion}
        </span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-balance text-ink">{finding.title}</h1>
      <p className="text-sm text-ink-2">
        <Link href={`/sites/${encodeURIComponent(finding.siteCode)}`} className="font-medium text-ink hover:underline">
          {finding.siteCode}
        </Link>{' '}
        {finding.siteName}
        {finding.asset && assetHref ? (
          <>
            {' · '}
            <Link href={assetHref} className="font-medium text-ink hover:underline">
              {finding.asset.code}
            </Link>{' '}
            {finding.asset.name}
          </>
        ) : (
          ' · 사이트 단위'
        )}
        {' · '}최초 {formatKstDateTime(finding.firstDetectedMs)} · 최근 {formatKstDateTime(finding.lastDetectedMs)} · {finding.detectionCount}회 탐지
        {finding.previousFindingId && (
          <>
            {' · 재발 (이전 '}
            <Link href={`/desk/${finding.previousFindingId}`} className="underline">
              #{finding.previousFindingId}
            </Link>
            )
          </>
        )}
      </p>
      <p className="max-w-prose text-ink">{finding.summary}</p>
      {finding.dismissReason && finding.status === 'dismissed' && <p className="text-sm text-muted">기각 사유: {finding.dismissReason}</p>}
      <TrustBadgeView badge={badge} detectorId={finding.detectorId} simEnabled={simEnabled} />
      <TransitionControls findingId={finding.id} status={finding.status} />
    </header>
  );
}
