'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CustomOverlayMap, Map as KakaoMap, useKakaoLoader, useMap } from 'react-kakao-maps-sdk';
import { Skeleton } from '@/components/ui/skeleton';
import type { SiteMapStatus } from '@/lib/data/site-map';
import { hiddenLabels } from './label-overlap';
import { MARKER_LABEL, SiteMarker } from './site-marker';

// NEXT_PUBLIC_ 변수는 빌드 때 번들에 들어간다. 값은 화면·로그에 출력하지 않는다.
const KAKAO_MAP_KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;

/** 지도 키가 설정되어 있는가 (없으면 부르는 쪽이 목록만 남긴다) */
export const hasMapKey = KAKAO_MAP_KEY !== undefined;

export interface MapView {
  readonly center: Readonly<{ lat: number; lng: number }>;
  readonly level: number;
}

/** 남한 전체가 보이는 중심·확대 수준 */
export const KOREA_VIEW: MapView = Object.freeze({ center: { lat: 35.9, lng: 127.8 }, level: 13 });

export interface FitPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 지도 대신 띄우는 안내. 지도 위에 뜬 목록·상세 패널에 가리지 않게 가운데 좁은 칸에 카드로 둔다 */
const NOTICE_WRAP_CLASS = 'flex h-full items-center justify-center p-4';
const NOTICE_CLASS = 'max-w-64 rounded-md border border-rule bg-surface/95 px-4 py-3 text-center text-sm text-balance shadow-md';

type LocatedSite = SiteMapStatus & { readonly lat: number; readonly lon: number };

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((value) => b.has(value));

/**
 * 좌표가 있는 사이트가 모두 보이게 맞춘다. Map의 onCreate에서 하면 뒤따르는 center·level 동기화가 되돌리므로
 * 지도 안 자식의 useEffect(부모 레이아웃 효과 뒤에 실행)에서 한다. 사이트가 없으면 남한 전체 보기 그대로 둔다.
 */
function FitToSites({ sites, padding }: Readonly<{ sites: readonly LocatedSite[]; padding: FitPadding }>) {
  const map = useMap();
  useEffect(() => {
    if (sites.length === 0) return;
    const bounds = new kakao.maps.LatLngBounds();
    sites.forEach((site) => bounds.extend(new kakao.maps.LatLng(site.lat, site.lon)));
    map.setBounds(bounds, padding.top, padding.right, padding.bottom, padding.left);
  }, [map, padding, sites]);
  return null;
}

/** 지도가 멈출 때마다 라벨 카드가 서로 겹치는지 보고, 급하지 않은 쪽 라벨을 접는다 */
function LabelOverlap({
  sites,
  pinnedCode,
  onChange,
}: Readonly<{ sites: readonly LocatedSite[]; pinnedCode: string | null; onChange: (hidden: ReadonlySet<string>) => void }>) {
  const map = useMap();
  useEffect(() => {
    const recompute = () => {
      const projection = map.getProjection();
      const points = sites.map((site) => {
        const point = projection.containerPointFromCoords(new kakao.maps.LatLng(site.lat, site.lon));
        return { code: site.code, x: point.x, y: point.y };
      });
      onChange(hiddenLabels(points, MARKER_LABEL, pinnedCode === null ? new Set() : new Set([pinnedCode])));
    };
    recompute();
    kakao.maps.event.addListener(map, 'idle', recompute);
    return () => kakao.maps.event.removeListener(map, 'idle', recompute);
  }, [map, onChange, pinnedCode, sites]);
  return null;
}

type Props = Readonly<{
  sites: readonly SiteMapStatus[];
  view: MapView;
  padding: FitPadding;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  nowMs: number;
  /** 정상인 곳의 마커를 작게 그린다 (오늘 화면: 문제 있는 곳만 눈에 들어오게). 수신 없음은 볼 수 없다는 문제라 그대로 크게 둔다 */
  subdueHealthy?: boolean;
  /** 지도 자리를 대신 채울 안내 (키가 없을 때) */
  label: string;
}>;

/** 카카오 지도와 사이트 마커. 지도 키가 없거나 불러오지 못하면 안내만 남기고 목록·패널이 화면을 맡는다 */
export function SiteMapCanvas({ sites, view, padding, selectedCode, onSelect, nowMs, subdueHealthy = false, label }: Props) {
  const located = useMemo(() => sites.filter((site): site is LocatedSite => site.lat !== null && site.lon !== null), [sites]);

  if (KAKAO_MAP_KEY === undefined) {
    return (
      <div className={NOTICE_WRAP_CLASS}>
        <p role="status" className={`${NOTICE_CLASS} text-ink-2`}>
          지도 키가 설정되지 않았습니다. {label}
          <span className="mt-1 block text-xs text-muted">(NEXT_PUBLIC_KAKAO_MAP_KEY)</span>
        </p>
      </div>
    );
  }
  return (
    <LoadedMap
      appKey={KAKAO_MAP_KEY}
      sites={located}
      view={view}
      padding={padding}
      selectedCode={selectedCode}
      onSelect={onSelect}
      nowMs={nowMs}
      subdueHealthy={subdueHealthy}
      label={label}
    />
  );
}

type LoadedProps = Omit<Props, 'sites'> & Readonly<{ appKey: string; sites: readonly LocatedSite[] }>;

function LoadedMap({ appKey, sites, view, padding, selectedCode, onSelect, nowMs, subdueHealthy, label }: LoadedProps) {
  const [loading, error] = useKakaoLoader({ appkey: appKey });
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const updateHidden = useCallback((next: ReadonlySet<string>) => setHidden((prev) => (sameSet(prev, next) ? prev : next)), []);

  if (error) {
    return (
      <div className={NOTICE_WRAP_CLASS}>
        <p role="alert" className={`${NOTICE_CLASS} text-warn`}>지도를 불러오지 못했습니다. {label}</p>
      </div>
    );
  }
  if (loading) return <Skeleton className="size-full" />;

  return (
    <KakaoMap center={view.center} level={view.level} isPanto className="size-full">
      <FitToSites sites={sites} padding={padding} />
      <LabelOverlap sites={sites} pinnedCode={selectedCode} onChange={updateHidden} />
      {sites.map((site) => {
        const active = site.code === selectedCode;
        // 오늘 화면(작은 지도)에서는 정상인 곳과, 겹쳐서 라벨을 접은 곳을 작은 점으로 줄여 옆 카드를 가리지 않게 한다.
        const quiet = subdueHealthy === true && !active && (site.level === 'normal' || hidden.has(site.code));
        return (
          // 선언형 오버레이: 마커 내용은 React가 그린다 (innerHTML 사용 안 함)
          <CustomOverlayMap key={site.code} position={{ lat: site.lat, lng: site.lon }} yAnchor={0.5} zIndex={active ? 20 : quiet ? 5 : 10} clickable>
            <SiteMarker site={site} active={active} subdued={quiet} labelHidden={quiet || hidden.has(site.code)} onSelect={() => onSelect(site.code)} nowMs={nowMs} />
          </CustomOverlayMap>
        );
      })}
    </KakaoMap>
  );
}
