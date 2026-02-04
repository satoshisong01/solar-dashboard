'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import MapTab from '@/components/tabs/MapTab';
import EfficiencyTab from '@/components/tabs/EfficiencyTab';
import MaintenanceTab from '@/components/tabs/MaintenanceTab';
import RevenueTab from '@/components/tabs/RevenueTab';

export default function Home() {
  const [activeTab, setActiveTab] = useState('map');
  const [isMobile, setIsMobile] = useState(false);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(0);

  // ☁️ 각 사이트별(ID) 최신 날씨를 저장하는 저장소
  const weatherMap = useRef<Record<number, any>>({});

  // 📏 화면 크기 감지
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 🔄 데이터 폴링 (사이트 목록 및 대시보드 데이터 가져오기)
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/solar');
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        const json = await res.json();

        if (!json.sites) throw new Error('Invalid Data Format');

        setData(json);
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch data:', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30 * 60 * 1000); // 30분마다
    return () => clearInterval(interval);
  }, []);

  // 🌤️ 1시간마다 모든 공장의 실제 날씨 조회 & weatherMap 업데이트
  useEffect(() => {
    // 사이트 정보가 로딩되지 않았으면 중단
    if (!data || !data.sites || data.sites.length === 0) return;

    const recordAllSitesWeather = async () => {
      console.log('🌦️ 1시간 주기: 날씨 갱신 시작...');

      for (const site of data.sites) {
        if (!site.lat || !site.lng) continue;

        try {
          // (1) 오픈웨더 API로 해당 공장 위치 날씨 조회
          const res = await fetch(
            `/api/weather?lat=${site.lat}&lon=${site.lng}`
          );
          const wData = await res.json();

          const weatherCondition = wData.weather;

          // (2) [메모리 저장] 시뮬레이션에서 쓰기 위해 저장
          weatherMap.current[site.id] = {
            temp: wData.temp,
            humidity: wData.humidity,
            weather: weatherCondition,
          };

          // (3) [분석용 DB 저장] 이력 남기기
          await fetch('/api/solar/weather-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              site_id: site.id,
              temp: wData.temp,
              humidity: wData.humidity,
              weather: weatherCondition,
            }),
          });

          console.log(
            `📍 [${site.name}] 업데이트: ${wData.temp}°C, ${weatherCondition}`
          );
        } catch (err) {
          console.error(`❌ [${site.name}] 날씨 조회 실패:`, err);
        }
      }
    };

    recordAllSitesWeather();
    const weatherInterval = setInterval(recordAllSitesWeather, 60 * 60 * 1000); // 1시간마다
    return () => clearInterval(weatherInterval);
  }, [data?.sites?.length]);

  // 🏭 IoT 데이터 생성 (30분 주기) - 🌟 날씨 기반 발전량 계산 로직 적용 완료
  useEffect(() => {
    if (!data || !data.sites) return;

    const simulateIoT = async () => {
      for (const site of data.sites) {
        // 1. 이 사이트의 최신 날씨 가져오기
        const siteWeather = weatherMap.current[site.id] || {
          temp: 20,
          humidity: 50,
          weather: 'Sunny',
        };

        const w = siteWeather.weather ? siteWeather.weather.toLowerCase() : '';

        // 2. 🌟 날씨에 따른 발전 효율 계수 설정 (0.0 ~ 1.0)
        let weatherFactor = 0.9; // 기본 맑음 (90%)

        if (w.includes('snow')) {
          weatherFactor = 0.15; // 눈 오면 15% (폭망)
        } else if (
          w.includes('rain') ||
          w.includes('thunder') ||
          w.includes('drizzle')
        ) {
          weatherFactor = 0.25; // 비 오면 25%
        } else if (w.includes('cloud') || w.includes('overcast')) {
          weatherFactor = 0.5; // 흐리면 50%
        } else if (
          w.includes('mist') ||
          w.includes('haze') ||
          w.includes('fog')
        ) {
          weatherFactor = 0.4; // 안개 끼면 40%
        } else {
          weatherFactor = 0.85 + Math.random() * 0.1; // 맑으면 85~95%
        }

        // 3. 목표 발전량 계산 (설비 용량 * 날씨 계수)
        // 예: 1000kW * 0.9(맑음) = 900kW 발전
        const targetPower = (site.capacity || 100) * weatherFactor;

        // 4. 전압/전류 역계산 (P = V * I)
        // 전압은 220V ~ 240V 사이 랜덤
        const voltage = 220 + Math.random() * 20;

        // 전류 = 목표전력(W) / 전압(V)  (kW -> W 변환 위해 * 1000)
        // 이렇게 해야 용량이 큰 발전소는 전류도 높게 나옵니다.
        const current = (targetPower * 1000) / voltage;

        // 약간의 랜덤 변동 추가 (자연스럽게 보이도록)
        const finalPower = targetPower * (0.98 + Math.random() * 0.04);
        const finalCurrent = (finalPower * 1000) / voltage;

        const newData = {
          site_id: site.id,
          temperature: siteWeather.temp,
          humidity: siteWeather.humidity,
          weather_condition: siteWeather.weather,
          voltage: parseFloat(voltage.toFixed(1)),
          current: parseFloat(finalCurrent.toFixed(1)),
          power_generation: parseFloat(finalPower.toFixed(2)),
        };

        try {
          // 비동기 전송
          fetch('/api/solar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newData),
          });
        } catch (error) {
          console.error('IoT 저장 실패:', error);
        }
      }
    };

    const interval = setInterval(simulateIoT, 30 * 60 * 1000); // 30분마다
    return () => clearInterval(interval);
  }, [data]);

  // 로딩 화면
  if (loading || !data || !data.sites) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="animate-pulse">시스템 데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  const menuItems = [
    { id: 'map', label: '통합 관제', icon: 'fa-map-marked-alt' },
    { id: 'efficiency', label: '발전 효율', icon: 'fa-chart-line' },
    { id: 'maintenance', label: '예지 보전', icon: 'fa-tools' },
    { id: 'revenue', label: '수익 관리', icon: 'fa-coins' },
  ];

  return (
    <div className="flex flex-col md:flex-row h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* 🟢 사이드바 */}
      <aside className="hidden md:flex w-64 flex-col bg-slate-900 border-r border-slate-800 shadow-xl z-20">
        <div className="p-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-white">
            SolarAI{' '}
            <span className="text-blue-500 text-base font-normal">EMS</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Intelligent Solar Monitoring
          </p>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group
                ${
                  activeTab === item.id
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
            >
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                ${
                  activeTab === item.id
                    ? 'bg-white/20'
                    : 'bg-slate-800 group-hover:bg-slate-700'
                }`}
              >
                <i className={`fas ${item.icon}`}></i>
              </div>
              <span className="font-bold text-sm">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-4 mt-auto">
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
            <div className="text-xs text-slate-400 mb-1">Total Power Gen</div>
            <div className="text-2xl font-bold text-green-400">
              {data.sites && data.sites.length > 0
                ? data.sites
                    .reduce((acc: number, cur: any) => acc + (cur.gen || 0), 0)
                    .toLocaleString()
                : '0'}{' '}
              <span className="text-sm text-slate-500">kW</span>
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-slate-400">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              {data.stats ? data.stats.operation_rate : 0}% 가동 중
            </div>
          </div>
        </div>
      </aside>

      {/* 🔴 메인 컨텐츠 */}
      <main className="flex-1 flex flex-col relative h-full overflow-hidden bg-slate-900">
        <div className="md:hidden h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 justify-between z-20 shrink-0">
          <h1 className="text-lg font-bold text-white">
            SolarAI <span className="text-blue-500 text-sm">EMS</span>
          </h1>
          <div className="flex items-center gap-2 text-xs font-bold bg-slate-800 px-3 py-1 rounded-full">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            {data.stats ? data.stats.operation_rate : 0}%
          </div>
        </div>

        <div className="flex-1 relative w-full h-full overflow-hidden">
          {activeTab === 'map' && (
            <MapTab
              sites={data.sites || []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}

          {activeTab !== 'map' && (
            <div className="h-full overflow-y-auto pb-[70px] md:pb-0">
              {activeTab === 'efficiency' && (
                <EfficiencyTab
                  inverters={data.inverters || []}
                  stats={data.stats || {}}
                />
              )}
              {activeTab === 'maintenance' && (
                <MaintenanceTab
                  sites={data.sites || []}
                  stats={data.stats || {}}
                  schedule={data.schedule || []}
                />
              )}
              {activeTab === 'revenue' && (
                <RevenueTab
                  revenue={data.revenue || []}
                  market={data.market || {}}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {/* 🟢 모바일 탭 바 */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-[60px] bg-slate-900 border-t border-slate-800 flex items-center justify-around z-50 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.3)]">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors active:scale-95
              ${
                activeTab === item.id
                  ? 'text-blue-500'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
          >
            <i className={`fas ${item.icon} text-lg mb-0.5`}></i>
            <span className="text-[10px] font-bold">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
