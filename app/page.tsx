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

  // 1. 화면 크기 감지 (반응형 처리)
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 2. API 데이터 폴링 (5초마다 갱신)
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/solar');
        const json = await res.json();
        setData(json);
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch data:', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !data) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="animate-pulse">시스템 데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  // 메뉴 아이템 정의
  const menuItems = [
    { id: 'map', label: '통합 관제', icon: 'fa-map-marked-alt' },
    { id: 'efficiency', label: '발전 효율', icon: 'fa-chart-line' },
    { id: 'maintenance', label: '예지 보전', icon: 'fa-tools' },
    { id: 'revenue', label: '수익 관리', icon: 'fa-coins' },
  ];

  return (
    <div className="flex flex-col md:flex-row h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* 🟢 [사이드바 - PC 전용] (md:flex, hidden) */}
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

        {/* 하단 요약 카드 (PC만 표시) */}
        <div className="p-4 mt-auto">
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
            <div className="text-xs text-slate-400 mb-1">Total Power Gen</div>
            <div className="text-2xl font-bold text-green-400">
              {data.sites
                .reduce((acc: number, cur: any) => acc + (cur.gen || 0), 0)
                .toLocaleString()}{' '}
              <span className="text-sm text-slate-500">kW</span>
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-slate-400">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              {data.stats.operation_rate}% 가동 중
            </div>
          </div>
        </div>
      </aside>

      {/* 🔴 [메인 컨텐츠 영역] */}
      <main className="flex-1 flex flex-col relative h-full overflow-hidden bg-slate-900">
        {/* 모바일 헤더 (상단 로고바) */}
        <div className="md:hidden h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 justify-between z-20 shrink-0">
          <h1 className="text-lg font-bold text-white">
            SolarAI <span className="text-blue-500 text-sm">EMS</span>
          </h1>
          <div className="flex items-center gap-2 text-xs font-bold bg-slate-800 px-3 py-1 rounded-full">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            {data.stats.operation_rate}%
          </div>
        </div>

        {/* 탭 컨텐츠 영역 */}
        <div className="flex-1 relative w-full h-full overflow-hidden">
          {activeTab === 'map' && (
            <MapTab
              sites={data.sites || []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}

          {/* 지도 외의 탭들은 스크롤이 필요하므로 wrapper로 감싸고 하단 패딩 추가 */}
          {activeTab !== 'map' && (
            <div className="h-full overflow-y-auto pb-[70px] md:pb-0">
              {activeTab === 'efficiency' && (
                <EfficiencyTab inverters={data.inverters} stats={data.stats} />
              )}
              {activeTab === 'maintenance' && (
                <MaintenanceTab
                  sites={data.sites}
                  stats={data.stats}
                  schedule={data.schedule}
                />
              )}
              {activeTab === 'revenue' && (
                <RevenueTab revenue={data.revenue} market={data.market} />
              )}
            </div>
          )}
        </div>
      </main>

      {/* 🟢 [하단 탭 바 - 모바일 전용] (md:hidden, fixed bottom) */}
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
