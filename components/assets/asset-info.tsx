import Link from 'next/link';
import { EmptyNote } from '@/components/ui/panel';
import type { AssetDetail, AssetLink } from '@/lib/data/assets';
import { ASSET_LEVEL_LABELS } from '@/lib/data/domains';

/** 명판(nameplate)과 설비 기본 정보 */
export function AssetNameplate({ asset }: Readonly<{ asset: AssetDetail }>) {
  const basics = [
    { title: '설비 종류', value: `${asset.className} (${asset.classKey})` },
    { title: '계층', value: ASSET_LEVEL_LABELS[asset.level] ?? asset.level },
    { title: '경로', value: asset.path },
    { title: '중요도', value: `${asset.criticality} / 5` },
    { title: '동종 그룹', value: asset.peerGroup ?? '없음' },
    { title: '준공일', value: asset.commissionedAt ?? '미등록' },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {basics.map((item) => (
          <div key={item.title} className="contents">
            <dt className="text-muted">{item.title}</dt>
            <dd className="text-ink break-all">{item.value}</dd>
          </div>
        ))}
      </dl>
      {asset.nameplate.length === 0 ? (
        <EmptyNote>명판 정보가 없습니다</EmptyNote>
      ) : (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md bg-sunken p-3 text-sm">
          {asset.nameplate.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-muted">{entry.title}</dt>
              <dd className="font-mono text-ink break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** 상위·하위 설비 링크 */
export function AssetLinks({ siteCode, parent, childAssets }: Readonly<{ siteCode: string; parent: AssetLink | null; childAssets: readonly AssetLink[] }>) {
  const href = (link: AssetLink) => `/sites/${encodeURIComponent(siteCode)}/assets/${link.id}`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-ink-2">
        상위 설비:{' '}
        {parent ? (
          <Link href={href(parent)} className="font-medium text-accent hover:underline">
            {parent.name} <span className="font-mono text-xs text-muted">{parent.code}</span>
          </Link>
        ) : (
          <span className="text-muted">없음 (사이트 바로 아래)</span>
        )}
      </p>
      {childAssets.length === 0 ? (
        <p className="text-muted">하위 설비가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {childAssets.map((child) => (
            <li key={child.id} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={href(child)} className="font-medium text-accent hover:underline">
                {child.name}
              </Link>
              <span className="font-mono text-xs text-muted">{child.code}</span>
              <span className="text-xs text-muted">
                {ASSET_LEVEL_LABELS[child.level] ?? child.level} · {child.className}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
