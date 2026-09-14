'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { CustomOverlayMap, Map as KakaoMap, useKakaoLoader, useMap } from 'react-kakao-maps-sdk';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status';
import type { StatusLevel } from '@/lib/data/fleet-status';

export interface MapSite {
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly level: StatusLevel;
}

type LocatedSite = MapSite & { readonly lat: number; readonly lon: number };

/** 남한 전체가 보이는 중심·확대 수준 */
const KOREA_CENTER = { lat: 35.9, lng: 127.8 } as const;
const KOREA_LEVEL = 13;
/** 사이트 라벨이 지도 가장자리에 잘리지 않을 여백(px). 라벨은 좌표 위쪽에 붙으므로 위를 넉넉히 둔다 */
const FIT_PADDING = { top: 72, right: 48, bottom: 24, left: 48 } as const;

// NEXT_PUBLIC_ 변수는 빌드 때 번들에 들어간다. 값은 화면·로그에 출력하지 않는다.
const KAKAO_MAP_KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;

function CoordinateTable({ sites }: Readonly<{ sites: readonly MapSite[] }>) {
  return (
    <TableScroll label="사이트 좌표 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>사이트</th>
            <th scope="col" className={TH_CLASS}>상태</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>위도</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>경도</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <tr key={site.code}>
              <th scope="row" className={`${TD_CLASS} font-medium`}>
                <Link href={`/sites/${encodeURIComponent(site.code)}`} className="text-ink hover:underline">{site.code}</Link>
                <span className="ml-2 text-xs font-normal text-muted">{site.name}</span>
              </th>
              <td className={TD_CLASS}><StatusBadge level={site.level} /></td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{site.lat?.toFixed(4) ?? '좌표 없음'}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{site.lon?.toFixed(4) ?? '좌표 없음'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/**
 * 좌표가 있는 사이트가 모두 보이게 맞춘다. Map의 onCreate에서 하면 뒤따르는 center·level 동기화가 되돌리므로
 * 지도 안 자식의 useEffect(부모 레이아웃 효과 뒤에 실행)에서 한다. 사이트가 없으면 남한 전체 보기 그대로 둔다.
 */
function FitToSites({ sites }: Readonly<{ sites: readonly LocatedSite[] }>) {
  const map = useMap();
  useEffect(() => {
    if (sites.length === 0) return;
    const bounds = new kakao.maps.LatLngBounds();
    sites.forEach((site) => bounds.extend(new kakao.maps.LatLng(site.lat, site.lon)));
    map.setBounds(bounds, FIT_PADDING.top, FIT_PADDING.right, FIT_PADDING.bottom, FIT_PADDING.left);
  }, [map, sites]);
  return null;
}

function KakaoFleetMap({ appKey, sites }: Readonly<{ appKey: string; sites: readonly LocatedSite[] }>) {
  const [loading, error] = useKakaoLoader({ appkey: appKey });

  if (error) {
    return <p role="alert" className="rounded-md border border-warn/40 bg-warn-fill px-3 py-2 text-sm text-warn">지도를 불러오지 못했습니다. 아래 좌표 표를 참고하세요.</p>;
  }
  if (loading) return <Skeleton className="h-[28rem] w-full" />;

  return (
    <KakaoMap center={KOREA_CENTER} level={KOREA_LEVEL} className="h-[28rem] w-full rounded-md border border-rule">
      <FitToSites sites={sites} />
      {sites.map((site) => (
        // 선언형 오버레이: 사이트 이름은 React가 텍스트로 넣는다 (innerHTML 사용 안 함)
        <CustomOverlayMap key={site.code} position={{ lat: site.lat, lng: site.lon }} yAnchor={1.1} clickable>
          <Link
            href={`/sites/${encodeURIComponent(site.code)}`}
            className="flex flex-col items-start gap-1 rounded-md border border-rule bg-surface px-2.5 py-1.5 text-xs shadow-md hover:border-accent"
          >
            <span className="font-semibold text-ink">
              {site.code} <span className="font-normal text-muted">{site.name}</span>
            </span>
            <StatusBadge level={site.level} />
          </Link>
        </CustomOverlayMap>
      ))}
    </KakaoMap>
  );
}

/** 사이트 상태 지도. 지도 키가 없거나 불러오지 못하면 좌표 표로 대신한다 */
export function FleetMap({ sites }: Readonly<{ sites: readonly MapSite[] }>) {
  if (sites.length === 0) return <EmptyNote>등록된 사이트가 없습니다</EmptyNote>;
  const located = sites.filter((site): site is LocatedSite => site.lat !== null && site.lon !== null);

  return (
    <div className="flex flex-col gap-4">
      {KAKAO_MAP_KEY ? (
        <KakaoFleetMap appKey={KAKAO_MAP_KEY} sites={located} />
      ) : (
        <p role="status" className="rounded-md border border-dashed border-rule-strong px-4 py-3 text-sm text-ink-2">
          지도 키가 설정되지 않았습니다. <span className="text-muted">(NEXT_PUBLIC_KAKAO_MAP_KEY)</span>
        </p>
      )}
      <CoordinateTable sites={sites} />
    </div>
  );
}
