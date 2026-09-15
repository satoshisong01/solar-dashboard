import { ArrowRight, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { FindingSeverityChip } from '@/components/desk/finding-badges';
import { SAFETY_FINDING_NOTICE } from '@/lib/desk/safety';
import type { SafetyFindingsBanner } from '@/lib/data/safety-banner';
import type { SafetyBanner as SafetyBannerData } from '@/lib/data/today';
import { formatKstDateTime } from '@/lib/format';

/** 열린 안전 발견사항 (분석 결과). 수집 즉시 경로의 안전 이벤트 배너와 구분해 따로 표시한다. 발견사항이 닫히면 사라진다 */
function SafetyFindingsSection({ findings }: Readonly<{ findings: SafetyFindingsBanner }>) {
  return (
    <section aria-labelledby="safety-findings-title" className="flex flex-col gap-3 rounded-lg border-2 border-crit/70 bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="safety-findings-title" className="flex items-center gap-2 text-base font-semibold text-crit">
          <TriangleAlert aria-hidden="true" className="size-5 shrink-0" />
          열린 안전 발견사항 {findings.count}건
          <span className="rounded border border-rule-strong px-1.5 py-px text-xs font-medium text-ink-2">분석 결과</span>
        </h2>
        <Link href="/desk?category=safety#inbox" className="inline-flex items-center gap-1.5 rounded-md border border-crit bg-surface px-3 py-1.5 text-sm font-medium text-crit hover:bg-crit-fill">
          분석 데스크에서 보기
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm text-ink">
        {findings.latest.map((finding) => (
          <li key={finding.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <FindingSeverityChip severity={finding.severity} />
            <span className="font-medium">{finding.siteCode}</span>
            <span className="text-ink-2">{finding.assetPath ? finding.assetPath.replace(`${finding.siteCode}/`, '') : '사이트 단위'}</span>
            <Link href={`/desk/${finding.id}`} className="font-medium hover:underline">
              {finding.title}
            </Link>
            <time dateTime={new Date(finding.lastDetectedMs).toISOString()} className="font-mono text-xs text-ink-2">
              최근 탐지 {formatKstDateTime(finding.lastDetectedMs)}
            </time>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-2">분석으로 추정한 안전 관련 발견사항입니다. 현장 안전책임자 판단과 가스 검지기 확인이 우선이며, 기각하거나 효과를 확인하면 이 표시에서 빠집니다. {SAFETY_FINDING_NOTICE}</p>
    </section>
  );
}

/** 미확인 안전 이벤트가 있으면 확인(ack) 전까지 항상 맨 위에 고정 표시한다. 닫기 버튼이 없다. 열린 안전 발견사항은 그 아래 따로 */
export function SafetyBanner({ banner }: Readonly<{ banner: SafetyBannerData }>) {
  const findings = banner.findings.count > 0 ? <SafetyFindingsSection findings={banner.findings} /> : null;
  if (banner.count === 0) {
    return (
      <>
        <p className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-4 py-2.5 text-sm text-ink-2">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
          미확인 안전 이벤트가 없습니다.
        </p>
        {findings}
      </>
    );
  }

  return (
    <>
      <section aria-labelledby="safety-banner-title" className="flex flex-col gap-3 rounded-lg border-2 border-crit bg-crit-fill p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="safety-banner-title" className="flex items-center gap-2 text-base font-semibold text-crit">
            <ShieldAlert aria-hidden="true" className="size-5 shrink-0" />
            미확인 안전 이벤트 {banner.count}건
          </h2>
          <Link
            href="/safety"
            className="inline-flex items-center gap-1.5 rounded-md border border-crit bg-surface px-3 py-1.5 text-sm font-medium text-crit hover:bg-crit-fill"
          >
            안전 화면에서 확인
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <ul className="flex flex-col gap-1.5 text-sm text-ink">
          {banner.latest.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-3 gap-y-0.5">
              <time dateTime={new Date(event.tsMs).toISOString()} className="font-mono text-xs text-ink-2">
                {formatKstDateTime(event.tsMs)}
              </time>
              <span className="font-medium">{event.siteCode}</span>
              <span>{event.assetName ?? event.sourceKey}</span>
              <span className="font-mono">{event.code}</span>
              {event.text && <span className="text-ink-2">{event.text}</span>}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-2">
          확인(ack)하기 전까지 이 표시는 사라지지 않습니다. 이 콘솔은 법정 안전설비·PLC 인터록을 대체하지 않습니다.
        </p>
      </section>
      {findings}
    </>
  );
}
