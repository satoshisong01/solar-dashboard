'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

declare global {
  interface Window {
    kakao: any;
  }
}

interface MapProps {
  sites: any[];
  selectedId: number;
  onSelect: (id: number) => void;
}

export default function MapTab({ sites, selectedId, onSelect }: MapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [isScriptLoaded, setIsScriptLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);

  // 🔴 [수정] 알림 카운트 로직 개선
  // 1. Critical (빨간불): is_error가 true인 경우
  const criticalCount = sites.filter((s) => s.is_error).length;
  // 2. Warning (주황불): 에러는 아니지만 status가 warning인 경우
  const warningCount = sites.filter(
    (s) => !s.is_error && s.status === 'warning'
  ).length;
  // 3. Total
  const totalAlerts = criticalCount + warningCount;

  // 1. 카카오 스크립트 로드 확인
  useEffect(() => {
    if (typeof window !== 'undefined' && window.kakao && window.kakao.maps) {
      setIsScriptLoaded(true);
    }
  }, []);

  // 2. 지도 초기화 및 마커 렌더링
  useEffect(() => {
    if (
      !isScriptLoaded ||
      !window.kakao ||
      !window.kakao.maps ||
      !mapContainerRef.current
    )
      return;

    try {
      window.kakao.maps.load(() => {
        if (!mapRef.current) {
          const centerSite = sites.find((s) => s.id === selectedId) ||
            sites[0] || { lat: 36.8, lng: 127.0 }; // 중심점 조정 (천안 부근)
          const options = {
            center: new window.kakao.maps.LatLng(
              centerSite.lat,
              centerSite.lng
            ),
            level: 10, // 레벨 조정 (지도가 넓게 보이도록)
          };
          mapRef.current = new window.kakao.maps.Map(
            mapContainerRef.current,
            options
          );
        }

        const map = mapRef.current;

        // 마커(커스텀 오버레이) 그리기
        sites.forEach((site) => {
          const position = new window.kakao.maps.LatLng(site.lat, site.lng);
          // 색상 결정: 에러(빨강) > 경고(노랑) > 정상(초록)
          const color = site.is_error
            ? '#ef4444'
            : site.status === 'warning'
            ? '#f59e0b'
            : '#22c55e';

          const content = document.createElement('div');
          // 마커 디자인
          content.innerHTML = `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center;">
              <div style="background-color: ${color}; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.3); cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10;">
                ${
                  site.is_error
                    ? '<span style="font-weight:bold; color:white; font-size:14px;">!</span>'
                    : ''
                }
              </div>
              <div style="margin-top: 8px; background: rgba(15, 23, 42, 0.9); color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap; font-weight: bold; border: 1px solid ${color}; z-index: 5;">
                ${site.name}
              </div>
            </div>
          `;

          content.addEventListener('click', () => {
            onSelect(site.id);
            map.panTo(position);
          });

          new window.kakao.maps.CustomOverlay({
            position: position,
            content: content,
            map: map,
            yAnchor: 0.5, // 마커 위치 미세 조정
          });
        });
      });
    } catch (err) {
      console.error('Kakao Map Error:', err);
      setMapError(true);
    }
  }, [isScriptLoaded, sites]);

  // 3. 선택 변경 시 이동
  useEffect(() => {
    if (mapRef.current && selectedId && window.kakao && window.kakao.maps) {
      const site = sites.find((s) => s.id === selectedId);
      if (site) {
        const moveLatLon = new window.kakao.maps.LatLng(site.lat, site.lng);
        mapRef.current.panTo(moveLatLon);
      }
    }
  }, [selectedId, sites]);

  return (
    <>
      <Script
        src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAP_KEY}&autoload=false`}
        onLoad={() => setIsScriptLoaded(true)}
        onError={() => setMapError(true)}
        strategy="afterInteractive"
      />

      <div className="relative w-full h-full bg-slate-800">
        {/* 🔴 [수정] 좌측 상단 상태 패널 업데이트 */}
        <div className="absolute top-4 left-4 z-10 flex gap-4">
          <div className="bg-slate-900/90 backdrop-blur border border-slate-700 p-4 rounded-xl shadow-xl flex items-center gap-4">
            <div>
              <div className="text-xs text-slate-400 font-bold mb-1">
                SYSTEM STATUS
              </div>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    totalAlerts > 0
                      ? 'bg-red-500 animate-pulse'
                      : 'bg-green-500'
                  }`}
                ></div>
                <span className="text-white font-bold">
                  {totalAlerts > 0
                    ? '이상 감지 (Check Required)'
                    : '정상 가동 중 (Normal)'}
                </span>
              </div>
            </div>
            <div className="w-px h-8 bg-slate-700"></div>
            <div>
              <div className="text-xs text-slate-400 font-bold mb-1">
                ALERTS
              </div>
              <div className="text-white font-bold">
                {/* 2 Critical, 2 Warning 형식으로 표시 */}
                {totalAlerts === 0 ? (
                  <span className="text-slate-500">None</span>
                ) : (
                  <span className="text-red-400">
                    {totalAlerts} Issues{' '}
                    <span className="text-xs text-slate-400 font-normal">
                      ({criticalCount} Crit, {warningCount} Warn)
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 지도 영역 */}
        <div
          ref={mapContainerRef}
          style={{ width: '100%', height: '100%', backgroundColor: '#1e293b' }}
        >
          {(!isScriptLoaded || mapError) && (
            <div className="flex items-center justify-center h-full text-slate-400">
              {mapError ? (
                <div className="text-red-400 text-center">
                  <p>지도 로딩 실패</p>
                  <p className="text-xs text-slate-500 mt-1">
                    도메인 등록 여부를 확인하세요.
                  </p>
                </div>
              ) : (
                <span className="animate-pulse">지도 로딩 중...</span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
