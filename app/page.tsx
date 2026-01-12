'use client';

import { useState, useEffect } from 'react';
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

  // 1. 실제 날씨 상태 관리
  const [realWeather, setRealWeather] = useState({
    temp: 20,
    humidity: 50,
    weather: 'Sunny',
  });

  // 2. 화면 크기 감지
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 3. 실제 날씨 가져오기
  useEffect(() => {
    const fetchRealWeather = async () => {
      try {
        const res = await fetch('/api/weather');
        const data = await res.json();
        setRealWeather({
          temp: data.temp,
          humidity: data.humidity,
          weather: data.weather === 'Clear' ? 'Sunny' : data.weather,
        });
      } catch (err) {
        console.error('날씨 정보 로딩 실패:', err);
      }
    };

    fetchRealWeather();
    const weatherInterval = setInterval(fetchRealWeather, 30 * 60 * 1000);
    return () => clearInterval(weatherInterval);
  }, []);

  // 4. IoT 데이터 생성 및 DB 저장
  useEffect(() => {
    const simulateIoT = async () => {
      const voltage = 220 + Math.random() * 10;
      const current = 10 + Math.random() * 5;
      const power = (voltage * current) / 1000;

      const newData = {
        temperature: realWeather.temp,
        humidity: realWeather.humidity,
        weather_condition: realWeather.weather,
        voltage: parseFloat(voltage.toFixed(1)),
        current: parseFloat(current.toFixed(1)),
        power_generation: parseFloat(power.toFixed(2)),
      };

      try {
        await fetch('/api/solar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newData),
        });
      } catch (error) {
        console.error('데이터 저장 실패:', error);
      }
    };

    const interval = setInterval(simulateIoT, 5000);
    return () => clearInterval(interval);
  }, [realWeather]);

  // 5. API 데이터 폴링
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/solar');

        // 🌟 에러 응답일 경우 처리
        if (!res.ok) {
          throw new Error(`API Error: ${res.status}`);
        }

        const json = await res.json();

        // 🌟 데이터 구조가 올바른지 확인 (sites가 없으면 에러로 간주)
        if (!json.sites) {
          throw new Error('Invalid Data Format');
        }

        setData(json);
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch data:', err);
        // 에러가 나도 로딩을 끄지 않거나, 에러 상태를 보여줄 수 있음
        // 여기서는 기존 데이터를 유지하거나 재시도를 위해 놔둠
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // 🌟 로딩 중이거나 데이터가 깨졌을 때 보호 (reduce 에러 방지)
  if (loading || !data || !data.sites) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="animate-pulse">시스템 데이터 로딩 중...</p>
          {/* 혹시 에러가 있다면 화면에 표시 (개발용) */}
          {data?.error && (
            <p className="text-red-400 text-sm">Error: {data.error}</p>
          )}
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
              {/* 🌟 안전장치: data.sites가 있을 때만 reduce 실행 */}
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

      {/* 🔴 메인 컨텐츠 영역 */}
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

      {/* 🟢 하단 탭 바 (모바일) */}
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
