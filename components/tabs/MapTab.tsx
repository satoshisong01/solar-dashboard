'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

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

  // 1. 선택된 사이트 찾기 (없으면 첫 번째)
  const selectedSite = sites.find((s) => s.id === selectedId) || sites[0];

  // 2. 알림 카운트 로직 (Critical + Warning)
  const criticalCount = sites.filter((s) => s.is_error).length;
  const warningCount = sites.filter(
    (s) => !s.is_error && s.status === 'warning'
  ).length;
  const totalAlerts = criticalCount + warningCount;

  // 3. 차트 색상 설정 (에러 시 빨강, 정상 시 초록)
  const chartColor = selectedSite?.is_error ? '#ef4444' : '#22c55e';
  const chartBgColor = selectedSite?.is_error
    ? 'rgba(239, 68, 68, 0.2)'
    : 'rgba(34, 197, 94, 0.2)';

  // 4. 지도 로드 여부 체크
  useEffect(() => {
    if (typeof window !== 'undefined' && window.kakao && window.kakao.maps) {
      setIsScriptLoaded(true);
    }
  }, []);

  // 5. 지도 렌더링
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
            sites[0] || { lat: 36.8, lng: 127.0 };
          const options = {
            center: new window.kakao.maps.LatLng(
              centerSite.lat,
              centerSite.lng
            ),
            level: 10,
          };
          mapRef.current = new window.kakao.maps.Map(
            mapContainerRef.current,
            options
          );
        }

        const map = mapRef.current;

        // 마커 그리기
        sites.forEach((site) => {
          const position = new window.kakao.maps.LatLng(site.lat, site.lng);
          const color = site.is_error
            ? '#ef4444'
            : site.status === 'warning'
            ? '#f59e0b'
            : '#22c55e';

          const content = document.createElement('div');
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
            yAnchor: 0.5,
          });
        });
      });
    } catch (err) {
      console.error('Kakao Map Error:', err);
      setMapError(true);
    }
  }, [isScriptLoaded, sites]); // selectedId는 의존성에서 제외 (지도 리렌더링 방지)

  // 6. 선택 변경 시 지도 이동
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

      <div className="flex-1 relative w-full h-full bg-slate-800">
        {/* 1. 지도 영역 (배경) */}
        <div
          ref={mapContainerRef}
          style={{ width: '100%', height: '100%', backgroundColor: '#1e293b' }}
        >
          {(!isScriptLoaded || mapError) && (
            <div className="flex items-center justify-center h-full text-slate-400">
              {mapError ? (
                <div className="text-red-400 text-center">
                  <p>지도 로딩 실패</p>
                </div>
              ) : (
                <span className="animate-pulse">지도 로딩 중...</span>
              )}
            </div>
          )}
        </div>

        {/* 2. HUD (좌측 상단 시스템 상태창) - 카운트 로직 적용됨 */}
        <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 pointer-events-none">
          <div className="bg-slate-900/90 border border-slate-700 backdrop-blur-md rounded-lg p-3 shadow-xl flex items-center gap-6 pointer-events-auto">
            <div className="flex items-center gap-3">
              <div
                className={`w-3 h-3 rounded-full ${
                  totalAlerts > 0
                    ? 'bg-red-500 animate-pulse'
                    : 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.8)]'
                }`}
              ></div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  System Status
                </div>
                <div className="text-sm font-bold text-white">
                  {totalAlerts > 0 ? '이상 감지' : '정상 가동 중'}
                </div>
              </div>
            </div>
            <div className="h-8 w-px bg-slate-700"></div>
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                Alerts
              </div>
              <div
                className={`text-sm font-bold ${
                  totalAlerts > 0
                    ? 'text-red-400 animate-pulse'
                    : 'text-slate-500'
                }`}
              >
                {totalAlerts > 0
                  ? `${totalAlerts} Issues (${criticalCount}C, ${warningCount}W)`
                  : 'None'}
              </div>
            </div>
          </div>
        </div>

        {/* 3. 우측 상세 패널 (복구됨!) */}
        {selectedSite && (
          <div className="absolute top-6 right-6 bottom-6 w-96 bg-slate-900/90 backdrop-blur-md border border-slate-700 rounded-xl p-6 flex flex-col gap-6 shadow-2xl z-10 overflow-y-auto">
            {/* 헤더 */}
            <div>
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold text-white">
                  {selectedSite.name}
                </h3>
                <span
                  className={`px-2 py-1 rounded text-xs font-bold text-white uppercase ${
                    selectedSite.is_error
                      ? 'bg-red-600'
                      : selectedSite.status === 'warning'
                      ? 'bg-yellow-600'
                      : 'bg-green-600'
                  }`}
                >
                  {selectedSite.status}
                </span>
              </div>
              <p className="text-xs text-slate-400 mb-4">
                지도상의 마커를 클릭하여 상세 정보를 확인하세요.
              </p>

              {/* 데이터 그리드 */}
              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-400">발전량 (Gen)</div>
                  <div className="text-lg font-bold text-white">
                    {selectedSite.gen}{' '}
                    <span className="text-xs font-normal">kW</span>
                  </div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-400">판매량 (Sale)</div>
                  <div className="text-lg font-bold text-green-400">
                    {selectedSite.sales}{' '}
                    <span className="text-xs font-normal">kW</span>
                  </div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-400">소비량 (Cons)</div>
                  <div className="text-lg font-bold text-blue-400">
                    {selectedSite.cons}{' '}
                    <span className="text-xs font-normal">kW</span>
                  </div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-400">발전 효율</div>
                  <div className="text-lg font-bold text-white">
                    {selectedSite.eff}{' '}
                    <span className="text-xs font-normal">%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 차트 영역 */}
            <div className="flex-1 flex flex-col gap-4">
              <div className="bg-slate-800/80 rounded-lg p-4 border border-slate-700 h-48">
                <Line
                  data={{
                    labels: ['10시', '11시', '12시', '13시', '14시', '15시'],
                    datasets: [
                      {
                        label: '발전량',
                        data: selectedSite.chartData,
                        borderColor: chartColor,
                        backgroundColor: chartBgColor,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                      x: { display: false },
                      y: { display: false, grid: { color: '#334155' } },
                    },
                  }}
                />
              </div>

              {/* AI 진단 리포트 */}
              <div
                className={`border rounded-lg p-4 ${
                  selectedSite.is_error
                    ? 'bg-red-900/30 border-red-500/30 animate-pulse'
                    : 'bg-blue-900/30 border-blue-500/30'
                }`}
              >
                <h4
                  className={`text-sm font-bold mb-2 flex items-center gap-2 ${
                    selectedSite.is_error ? 'text-red-400' : 'text-blue-400'
                  }`}
                >
                  <i className="fas fa-brain"></i> AI 진단 리포트
                </h4>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {selectedSite.ai_msg}
                </p>
              </div>

              {/* 조치 필요 사항 */}
              {selectedSite.actions && selectedSite.actions.length > 0 && (
                <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
                  <h4 className="text-sm font-bold text-red-400 mb-2">
                    <i className="fas fa-wrench mr-2"></i>조치 필요
                  </h4>
                  <ul className="text-xs text-slate-300 space-y-2">
                    {selectedSite.actions.map((act: string, idx: number) => (
                      <li key={idx} className="flex items-center gap-2">
                        <i className="fas fa-check-circle text-red-500"></i>{' '}
                        {act}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
