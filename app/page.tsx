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
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/solar')
      .then((res) => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      })
      .then((resData) => {
        setData(resData);
        if (resData.sites?.length > 0) setSelectedId(resData.sites[0].id);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Fetch Error:', err);
        setError(true);
        setLoading(false);
      });
  }, []);

  if (loading)
    return (
      <div className="h-screen bg-slate-900 flex items-center justify-center text-white">
        Loading SolarAI...
      </div>
    );

  // 데이터 로딩 실패 시 에러 화면 표시
  if (error || !data) {
    return (
      <div className="h-screen bg-slate-900 flex flex-col items-center justify-center text-white gap-4">
        <div className="text-red-400 text-xl font-bold">
          서버 연결 실패 (500 Error)
        </div>
        <p className="text-slate-400">
          Vercel 환경변수(DB 정보)를 확인해주세요.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500"
        >
          새로고침
        </button>
      </div>
    );
  }

  // 데이터가 있을 때만 안전하게 계산 (Optional Chaining 사용)
  const totalGen =
    data.sites
      ?.reduce((acc: number, cur: any) => acc + (cur.gen || 0), 0)
      .toLocaleString() || '0';

  return (
    <div className="flex h-screen bg-slate-900 text-slate-200 overflow-hidden font-sans">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        totalGen={totalGen}
      />

      <main className="flex-1 flex flex-col relative bg-slate-900 overflow-hidden">
        <Header activeTab={activeTab} />

        {activeTab === 'map' && (
          <MapTab
            sites={data.sites || []}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}

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
          <RevenueTab revenue={data.revenue || []} market={data.market || {}} />
        )}
      </main>
    </div>
  );
}
