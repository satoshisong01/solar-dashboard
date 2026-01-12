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
  const overlaysRef = useRef<any[]>([]);

  const [isScriptLoaded, setIsScriptLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [isPanelExpanded, setIsPanelExpanded] = useState(true);

  // 🌟 [핵심 수정 1] 차트 데이터가 없으면 시뮬레이션 데이터로 채워넣기
  const rawSelectedSite = sites.find((s) => s.id === selectedId) || sites[0];

  const selectedSite = rawSelectedSite
    ? {
        ...rawSelectedSite,
        // 차트 라벨 (고정)
        chartLabels: ['11:00', '12:00', '13:00', '14:00', '15:00', '현재'],
        // 차트 데이터 (DB 값이 있으면 쓰고, 없거나 0이면 현재 발전량 기반으로 역산해서 만듦)
        chartData:
          rawSelectedSite.chart_values &&
          rawSelectedSite.chart_values.some((v: number) => v > 0)
            ? rawSelectedSite.chart_values
            : [
                (rawSelectedSite.gen || 0) * 0.4,
                (rawSelectedSite.gen || 0) * 0.6,
                (rawSelectedSite.gen || 0) * 0.85,
                (rawSelectedSite.gen || 0) * 0.95,
                (rawSelectedSite.gen || 0) * 0.8,
                rawSelectedSite.gen || 0,
              ],
      }
    : null;

  const criticalCount = sites.filter((s) => s.is_error).length;
  const warningCount = sites.filter(
    (s) => !s.is_error && s.status === 'warning'
  ).length;
  const totalAlerts = criticalCount + warningCount;

  const chartColor = selectedSite?.is_error
    ? '#ef4444'
    : selectedSite?.status === 'warning'
    ? '#eab308'
    : '#22c55e';
  const chartBgColor = selectedSite?.is_error
    ? 'rgba(239, 68, 68, 0.2)'
    : selectedSite?.status === 'warning'
    ? 'rgba(234, 179, 8, 0.2)'
    : 'rgba(34, 197, 94, 0.2)';

  // 날씨 정보 헬퍼 함수
  const getWeatherInfo = (weather: string) => {
    const w = weather ? weather.toLowerCase() : '';

    if (w.includes('snow')) {
      return { text: '눈', icon: 'fa-snowflake' };
    } else if (
      w.includes('rain') ||
      w.includes('drizzle') ||
      w.includes('thunder')
    ) {
      return { text: '비', icon: 'fa-cloud-showers-heavy' };
    } else if (w.includes('mist') || w.includes('haze') || w.includes('fog')) {
      return { text: '안개', icon: 'fa-smog' };
    } else if (w.includes('cloud') || w.includes('overcast')) {
      return { text: '흐림', icon: 'fa-cloud' };
    } else if (w.includes('clear') || w.includes('sun')) {
      return { text: '맑음', icon: 'fa-sun' };
    } else {
      return { text: '흐림', icon: 'fa-cloud' };
    }
  };

  useEffect(() => {
    if (selectedId) {
      setIsPanelExpanded(true);
    }
  }, [selectedId]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.kakao && window.kakao.maps) {
      setIsScriptLoaded(true);
    }
  }, []);

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
            draggable: true,
          };
          mapRef.current = new window.kakao.maps.Map(
            mapContainerRef.current,
            options
          );
        }

        const map = mapRef.current;

        if (overlaysRef.current.length > 0) {
          overlaysRef.current.forEach((overlay) => overlay.setMap(null));
          overlaysRef.current = [];
        }

        sites.forEach((site) => {
          const position = new window.kakao.maps.LatLng(site.lat, site.lng);
          const color = site.is_error
            ? '#ef4444'
            : site.status === 'warning'
            ? '#f59e0b'
            : '#22c55e';
          const isSelected = site.id === selectedId;
          const zIndex = isSelected ? 999 : 1;
          const transform = isSelected ? 'scale(1.1)' : 'scale(1.0)';
          const opacity = isSelected ? '1' : '0.95';

          const { text: weatherText, icon: weatherIcon } = getWeatherInfo(
            site.weather
          );

          // 온도 표시 (데이터가 있으면 표시)
          const tempDisplay = site.temp
            ? ` <span style="font-weight:bold; margin-left:2px;">${site.temp}°C</span>`
            : '';

          const content = document.createElement('div');

          content.innerHTML = `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center; z-index: ${zIndex}; transform: ${transform}; opacity: ${opacity}; transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
              <div style="background-color: ${color}; width: 32px; height: 32px; border-radius: 50%; border: ${
            isSelected ? '3px' : '2px'
          } solid white; box-shadow: 0 4px 10px rgba(0,0,0,${
            isSelected ? '0.6' : '0.3'
          }); cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 10;">
                ${
                  site.is_error
                    ? '<i class="fas fa-exclamation text-white"></i>'
                    : `<i class="fas ${weatherIcon} text-white" style="font-size:14px;"></i>`
                }
              </div>
              <div style="margin-top: 8px; background: rgba(15, 23, 42, 0.95); color: white; padding: 8px 12px; border-radius: 8px; font-size: 12px; border: ${
                isSelected ? '2px solid white' : `1px solid ${color}`
              }; z-index: 5; text-align: center; min-width: 140px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
                <div style="font-weight: bold; margin-bottom: 4px; font-size: 13px;">${
                  site.name
                }</div>
                <div style="color: #cbd5e1; font-size: 11px; display: flex; justify-content: center; gap: 6px; margin-bottom: 4px;">
                   <span><i class="fas ${weatherIcon}"></i> ${weatherText}${tempDisplay}</span>
                   ${
                     site.fail_date
                       ? `<span style="color: #fbbf24;">(⚠ ${site.fail_date})</span>`
                       : ''
                   }
                </div>
                ${
                  site.loss_amt && site.loss_amt !== 0 && site.loss_amt !== '0'
                    ? `
                  <div style="background-color: rgba(239, 68, 68, 0.2); color: #fca5a5; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-top: 2px;">
                    💸 손실: -${site.loss_amt}원/h
                  </div>
                `
                    : `
                  <div style="color: #86efac; font-size: 11px;">
                    정상 가동 중
                  </div>
                `
                }
              </div>
            </div>
          `;

          content.addEventListener('click', () => {
            onSelect(site.id);
            map.panTo(position);
          });

          const overlay = new window.kakao.maps.CustomOverlay({
            position: position,
            content: content,
            map: map,
            yAnchor: 0.4,
            zIndex: zIndex,
          });

          overlaysRef.current.push(overlay);
        });
      });
    } catch (err) {
      console.error('Kakao Map Error:', err);
      setMapError(true);
    }
  }, [isScriptLoaded, sites, selectedId]);

  useEffect(() => {
    if (mapRef.current && selectedId && window.kakao && window.kakao.maps) {
      const site = sites.find((s) => s.id === selectedId);
      if (site) {
        const moveLatLon = new window.kakao.maps.LatLng(site.lat, site.lng);
        mapRef.current.panTo(moveLatLon);
      }
    }
  }, [selectedId, sites]);

  // 선택된 사이트가 없으면 렌더링 안 함
  if (!selectedSite) return null;

  const { text: selectedWeatherText, icon: selectedWeatherIcon } =
    getWeatherInfo(selectedSite.weather);

  return (
    <>
      <Script
        src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_MAP_KEY}&autoload=false`}
        onLoad={() => setIsScriptLoaded(true)}
        onError={() => setMapError(true)}
        strategy="afterInteractive"
      />

      <div className="flex-1 w-full h-full bg-slate-900 p-0 md:p-6 relative">
        <div className="relative w-full h-full md:rounded-2xl overflow-hidden md:border md:border-slate-700 md:shadow-2xl">
          <div
            ref={mapContainerRef}
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: '#1e293b',
              touchAction: 'none',
            }}
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
              <div className="hidden md:block h-8 w-px bg-slate-700"></div>
              <div className="hidden md:block">
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

          {selectedSite && (
            <div
              className={`
                z-20 flex flex-col transition-all duration-300 ease-in-out
                absolute left-0 right-0 bottom-[70px] px-4 pointer-events-none
                md:absolute md:top-6 md:right-6 md:bottom-6 md:left-auto md:w-96 md:px-0 md:pointer-events-auto
            `}
            >
              <div
                className={`
                  w-full bg-slate-900/95 backdrop-blur-md border border-slate-700 shadow-2xl rounded-2xl md:rounded-xl p-4 md:p-6
                  pointer-events-auto overflow-hidden flex flex-col
                  ${
                    isPanelExpanded
                      ? 'max-h-[60vh] md:max-h-full md:h-auto'
                      : 'h-auto'
                  }
              `}
              >
                <div
                  className="md:hidden w-full flex justify-center mb-2 cursor-pointer pt-1 pb-3 hover:bg-white/5 rounded"
                  onClick={() => setIsPanelExpanded(!isPanelExpanded)}
                >
                  <div className="w-12 h-1.5 bg-slate-600 rounded-full"></div>
                </div>

                <div className="flex justify-between items-start mb-2 shrink-0">
                  <div className="flex-1">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg md:text-xl font-bold text-white">
                        {selectedSite.name}
                      </h3>
                      <button
                        onClick={() => setIsPanelExpanded(!isPanelExpanded)}
                        className="md:hidden text-slate-400 p-2"
                      >
                        <i
                          className={`fas fa-chevron-${
                            isPanelExpanded ? 'down' : 'up'
                          }`}
                        ></i>
                      </button>
                    </div>

                    <span
                      className={`inline-block mt-1 px-2 py-1 rounded text-[10px] md:text-xs font-bold text-white uppercase ${
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
                </div>

                <div
                  className={`
                      flex flex-col gap-4 overflow-y-auto custom-scrollbar
                      ${isPanelExpanded ? 'block' : 'hidden md:flex'}
                  `}
                >
                  {/* 날씨 텍스트 옆에 온도 표시 */}
                  <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
                    <span>
                      <i className={`fas ${selectedWeatherIcon} mr-1`}></i>
                      {selectedWeatherText}
                      {selectedSite.temp && (
                        <span className="font-bold ml-1">
                          ({selectedSite.temp}°C)
                        </span>
                      )}
                    </span>
                    {selectedSite.fail_date && (
                      <span className="text-yellow-500 ml-2">
                        ⚠ 고장 예측: {selectedSite.fail_date}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 mt-2 shrink-0">
                    <div className="bg-slate-800/50 p-2 md:p-3 rounded border border-slate-700">
                      <div className="text-[10px] md:text-xs text-slate-400">
                        발전량 (Gen)
                      </div>
                      <div className="text-base md:text-lg font-bold text-white">
                        {selectedSite.gen}{' '}
                        <span className="text-xs font-normal">kW</span>
                      </div>
                    </div>
                    <div className="bg-slate-800/50 p-2 md:p-3 rounded border border-slate-700">
                      <div className="text-[10px] md:text-xs text-slate-400">
                        판매량 (Sale)
                      </div>
                      <div className="text-base md:text-lg font-bold text-green-400">
                        {selectedSite.sales}{' '}
                        <span className="text-xs font-normal">kW</span>
                      </div>
                    </div>
                    <div className="bg-slate-800/50 p-2 md:p-3 rounded border border-slate-700">
                      <div className="text-[10px] md:text-xs text-slate-400">
                        소비량 (Cons)
                      </div>
                      <div className="text-base md:text-lg font-bold text-blue-400">
                        {selectedSite.cons}{' '}
                        <span className="text-xs font-normal">kW</span>
                      </div>
                    </div>
                    <div className="bg-slate-800/50 p-2 md:p-3 rounded border border-slate-700">
                      <div className="text-[10px] md:text-xs text-slate-400">
                        발전 효율
                      </div>
                      <div className="text-base md:text-lg font-bold text-white">
                        {selectedSite.eff}{' '}
                        <span className="text-xs font-normal">%</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col gap-4 min-h-[200px]">
                    <div className="bg-slate-800/80 rounded-lg p-3 md:p-4 border border-slate-700 h-40 md:h-48 shrink-0">
                      <Line
                        data={{
                          labels: selectedSite.chartLabels,
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

                    <div
                      className={`border rounded-lg p-3 md:p-4 ${
                        selectedSite.is_error
                          ? 'bg-red-900/30 border-red-500/30 animate-pulse'
                          : selectedSite.status === 'warning'
                          ? 'bg-yellow-900/20 border-yellow-500/30'
                          : 'bg-blue-900/30 border-blue-500/30'
                      }`}
                    >
                      <h4
                        className={`text-xs md:text-sm font-bold mb-2 flex items-center gap-2 ${
                          selectedSite.is_error
                            ? 'text-red-400'
                            : selectedSite.status === 'warning'
                            ? 'text-yellow-400'
                            : 'text-blue-400'
                        }`}
                      >
                        <i className="fas fa-brain"></i> AI 진단 리포트
                      </h4>
                      {/* 🌟 [핵심 수정 2] AI 리포트가 비어있으면 기본 문구 출력 */}
                      <p className="text-xs md:text-sm text-slate-300 leading-relaxed">
                        {selectedSite.ai_msg ||
                          '현재 특이사항 없음 (정상 가동 중)'}
                      </p>

                      {selectedSite.loss_amt &&
                        selectedSite.loss_amt !== 0 &&
                        selectedSite.loss_amt !== '0' && (
                          <div className="mt-3 pt-3 border-t border-white/10 text-red-300 font-bold text-xs md:text-sm">
                            <i className="fas fa-coins mr-2"></i> 예상 손실:{' '}
                            {selectedSite.loss_amt}원/h
                          </div>
                        )}
                    </div>

                    {selectedSite.actions &&
                      selectedSite.actions.length > 0 && (
                        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 md:p-4">
                          <h4 className="text-xs md:text-sm font-bold text-slate-300 mb-2">
                            <i className="fas fa-wrench mr-2"></i>조치 필요
                          </h4>
                          <ul className="text-[10px] md:text-xs text-slate-400 space-y-2">
                            {selectedSite.actions.map(
                              (act: string, idx: number) => (
                                <li
                                  key={idx}
                                  className="flex items-center gap-2"
                                >
                                  <i className="fas fa-check-circle text-blue-500"></i>{' '}
                                  {act}
                                </li>
                              )
                            )}
                          </ul>
                        </div>
                      )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
