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

export default function Map({ sites, selectedId, onSelect }: MapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [isScriptLoaded, setIsScriptLoaded] = useState(false);

  // 1. 카카오 스크립트 로드 확인
  useEffect(() => {
    if (window.kakao && window.kakao.maps) {
      setIsScriptLoaded(true);
    }
  }, []);

  // 2. 지도 초기화 및 마커 렌더링
  useEffect(() => {
    if (!isScriptLoaded || !mapContainerRef.current || sites.length === 0)
      return;

    // 카카오맵 로드 대기
    window.kakao.maps.load(() => {
      // 2-1. 지도 생성 (이미 있다면 재사용하지 않고 새로 생성하거나, 마커만 갱신하는 방식 등 선택 가능)
      // 여기서는 간단하게 초기 1회 생성 후 마커만 관리하겠습니다.
      if (!mapRef.current) {
        const centerSite = sites.find((s) => s.id === selectedId) || sites[0];
        const options = {
          center: new window.kakao.maps.LatLng(centerSite.lat, centerSite.lng),
          level: 11, // 줌 레벨 (숫자가 클수록 멀리 보임 -> 카카오는 반대: 숫자가 클수록 축소)
        };
        mapRef.current = new window.kakao.maps.Map(
          mapContainerRef.current,
          options
        );
      }

      const map = mapRef.current;

      // 2-2. 기존 오버레이(마커) 제거 로직이 필요하다면 여기에 추가 (배열에 담아두고 setMap(null))
      // 이 예제에서는 sites가 자주 바뀌지 않는다고 가정하고 바로 그립니다.

      // 2-3. 마커(CustomOverlay) 생성
      sites.forEach((site) => {
        const position = new window.kakao.maps.LatLng(site.lat, site.lng);

        // 상태별 색상 지정
        const color = site.is_error
          ? '#ef4444' // Red
          : site.status === 'warning'
          ? '#eab308' // Yellow
          : '#22c55e'; // Green

        // 커스텀 오버레이 내용 (CSS 스타일 적용된 HTML)
        const content = document.createElement('div');
        content.innerHTML = `
          <div style="
            background-color: ${color};
            width: 24px;
            height: 24px;
            border-radius: 50%;
            border: 3px solid white;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            cursor: pointer;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
          ">
            ${
              site.is_error
                ? '<span style="font-weight:bold; color:white; font-size:14px;">!</span>'
                : ''
            }
          </div>
          <div style="
            position: absolute;
            top: -35px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(15, 23, 42, 0.9);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            white-space: nowrap;
            pointer-events: none;
            border: 1px solid rgba(255,255,255,0.2);
          ">
            ${site.name}
          </div>
        `;

        // 클릭 이벤트 리스너 추가
        content.addEventListener('click', () => {
          onSelect(site.id);
          // 부드럽게 이동
          map.panTo(position);
        });

        // CustomOverlay 생성
        new window.kakao.maps.CustomOverlay({
          position: position,
          content: content,
          map: map,
          yAnchor: 1, // 마커의 바닥 부분이 좌표에 오도록 설정
        });
      });
    });
  }, [isScriptLoaded, sites]); // sites 데이터가 변경되면 다시 그림

  // 3. 선택된 발전소가 바뀌면 지도 중심 이동
  useEffect(() => {
    if (mapRef.current && selectedId && isScriptLoaded) {
      const site = sites.find((s) => s.id === selectedId);
      if (site) {
        const moveLatLon = new window.kakao.maps.LatLng(site.lat, site.lng);
        mapRef.current.panTo(moveLatLon);
      }
    }
  }, [selectedId, sites, isScriptLoaded]);

  return (
    <>
      <Script
        src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAP_KEY}&autoload=false`}
        onLoad={() => setIsScriptLoaded(true)}
        strategy="afterInteractive"
      />

      <div
        ref={mapContainerRef}
        style={{ width: '100%', height: '100%', backgroundColor: '#1e293b' }}
      >
        {!isScriptLoaded && (
          <div className="flex items-center justify-center h-full text-slate-400">
            <span className="animate-pulse">지도 로딩 중....</span>
          </div>
        )}
      </div>
    </>
  );
}
