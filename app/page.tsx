'use client';

import { useState, useEffect } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import MapTab from '@/components/tabs/MapTab';
import EfficiencyTab from '@/components/tabs/EfficiencyTab';
import MaintenanceTab from '@/components/tabs/MaintenanceTab';
import RevenueTab from '@/components/tabs/RevenueTab';

export default function Home() {
  const [activeTab, setActiveTab] = useState('map');
  const [data, setData] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  // 초기 데이터 로딩
  useEffect(() => {
    fetch('/api/solar')
      .then((res) => res.json())
      .then((resData) => {
        setData(resData);
        if (resData.sites?.length > 0) setSelectedId(resData.sites[0].id);
        setLoading(false);
      });
  }, []);

  if (loading || !data)
    return (
      <div className="h-screen bg-slate-900 flex items-center justify-center text-white">
        Loading SolarAI...
      </div>
    );

  const totalGen = data.sites
    .reduce((acc: number, cur: any) => acc + (cur.gen || 0), 0)
    .toLocaleString();

  return (
    <div className="flex h-screen bg-slate-900 text-slate-200 overflow-hidden font-sans">
      {/* 1. 사이드바 */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        totalGen={totalGen}
      />

      {/* 2. 메인 영역 */}
      <main className="flex-1 flex flex-col relative bg-slate-900 overflow-hidden">
        <Header activeTab={activeTab} />

        {/* 탭 컨텐츠 영역 */}
        {activeTab === 'map' && (
          <MapTab
            sites={data.sites}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
          />
        )}

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
      </main>
    </div>
  );
}
