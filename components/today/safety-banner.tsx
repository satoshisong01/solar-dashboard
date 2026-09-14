import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { SafetyBanner as SafetyBannerData } from '@/lib/data/today';
import { formatKstDateTime } from '@/lib/format';

/** 미확인 안전 이벤트가 있으면 확인(ack) 전까지 항상 맨 위에 고정 표시한다. 닫기 버튼이 없다 */
export function SafetyBanner({ banner }: Readonly<{ banner: SafetyBannerData }>) {
  if (banner.count === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-4 py-2.5 text-sm text-ink-2">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
        미확인 안전 이벤트가 없습니다.
      </p>
    );
  }

  return (
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
  );
}
