'use client';
import dynamic from 'next/dynamic';
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

// 카카오맵 컴포넌트 불러오기 (SSR 방지)
const MapComponent = dynamic(() => import('../Maps'), { ssr: false });

interface MapTabProps {
  sites: any[];
  selectedId: number;
  setSelectedId: (id: number) => void;
}

export default function MapTab({
  sites,
  selectedId,
  setSelectedId,
}: MapTabProps) {
  // 선택된 사이트가 없으면 첫 번째 사이트를 보여줌
  const selectedSite = sites.find((s) => s.id === selectedId) || sites[0];

  // 차트 데이터 설정 (에러 상태일 때 빨간색, 정상일 때 초록색)
  const chartColor = selectedSite?.is_error ? '#ef4444' : '#22c55e';
  const chartBgColor = selectedSite?.is_error
    ? 'rgba(239, 68, 68, 0.2)'
    : 'rgba(34, 197, 94, 0.2)';

  return (
    <div className="flex-1 relative w-full h-full">
      {/* 1. 지도 영역 (배경) */}
      <MapComponent
        sites={sites}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      {/* 2. HUD (좌측 상단 시스템 상태창) */}
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 pointer-events-none">
        <div className="bg-slate-900/90 border border-slate-700 backdrop-blur-md rounded-lg p-3 shadow-xl flex items-center gap-6 pointer-events-auto">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.8)]"></div>
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                System Status
              </div>
              <div className="text-sm font-bold text-white">정상 가동 중</div>
            </div>
          </div>
          <div className="h-8 w-px bg-slate-700"></div>
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider">
              Alerts
            </div>
            <div className="text-sm font-bold text-red-400 animate-pulse">
              1 Warning
            </div>
          </div>
        </div>
      </div>

      {/* 3. 우측 상세 패널 (Glassmorphism) - 여기가 핵심 수정 부분입니다 */}
      {selectedSite && (
        <div className="absolute top-6 right-6 bottom-6 w-96 bg-slate-900/90 backdrop-blur-md border border-slate-700 rounded-xl p-6 flex flex-col gap-6 shadow-2xl z-10 overflow-y-auto">
          {/* (1) 헤더: 이름 및 상태 */}
          <div>
            <div className="flex justify-between items-start mb-2">
              <h3 className="text-xl font-bold text-white">
                {selectedSite.name}
              </h3>
              <span
                className={`px-2 py-1 rounded text-xs font-bold text-white uppercase
                  ${
                    selectedSite.is_error
                      ? 'bg-red-600'
                      : selectedSite.status === 'warning'
                      ? 'bg-yellow-600'
                      : 'bg-green-600'
                  }
                `}
              >
                {selectedSite.status}
              </span>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              지도상의 마커를 클릭하여 상세 정보를 확인하세요.
            </p>

            {/* (2) 데이터 그리드 (4칸: 발전, 판매, 소비, 효율) */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              {/* 발전량 */}
              <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400">발전량 (Gen)</div>
                <div className="text-lg font-bold text-white">
                  {selectedSite.gen}{' '}
                  <span className="text-xs font-normal">kW</span>
                </div>
              </div>

              {/* 판매량 (초록색 포인트) */}
              <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400">판매량 (Sale)</div>
                <div className="text-lg font-bold text-green-400">
                  {selectedSite.sales}{' '}
                  <span className="text-xs font-normal">kW</span>
                </div>
              </div>

              {/* 소비량 (파란색 포인트) */}
              <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400">소비량 (Cons)</div>
                <div className="text-lg font-bold text-blue-400">
                  {selectedSite.cons}{' '}
                  <span className="text-xs font-normal">kW</span>
                </div>
              </div>

              {/* 효율 */}
              <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400">발전 효율</div>
                <div className="text-lg font-bold text-white">
                  {selectedSite.eff}{' '}
                  <span className="text-xs font-normal">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* (3) 차트 영역 */}
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
                      tension: 0.4, // 부드러운 곡선
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
                    y: {
                      display: false,
                      grid: { color: '#334155' },
                    },
                  },
                }}
              />
            </div>

            {/* (4) AI 진단 리포트 */}
            <div
              className={`border rounded-lg p-4 
                ${
                  selectedSite.is_error
                    ? 'bg-red-900/30 border-red-500/30 animate-pulse'
                    : 'bg-blue-900/30 border-blue-500/30'
                }`}
            >
              <h4
                className={`text-sm font-bold mb-2 flex items-center gap-2
                 ${selectedSite.is_error ? 'text-red-400' : 'text-blue-400'}`}
              >
                <i className="fas fa-brain"></i> AI 진단 리포트
              </h4>
              <p className="text-sm text-slate-300 leading-relaxed">
                {selectedSite.ai_msg}
              </p>
            </div>

            {/* (5) 조치 필요 사항 (에러 있거나 조치사항 있을 때만 표시) */}
            {selectedSite.actions && selectedSite.actions.length > 0 && (
              <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
                <h4 className="text-sm font-bold text-red-400 mb-2">
                  <i className="fas fa-wrench mr-2"></i>조치 필요
                </h4>
                <ul className="text-xs text-slate-300 space-y-2">
                  {selectedSite.actions.map((act: string, idx: number) => (
                    <li key={idx} className="flex items-center gap-2">
                      <i className="fas fa-check-circle text-red-500"></i> {act}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
