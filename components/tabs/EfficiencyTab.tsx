'use client';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

interface EfficiencyProps {
  inverters: any[];
  stats: any;
}

export default function EfficiencyTab({ inverters, stats }: EfficiencyProps) {
  // 🌟 [핵심 수정] 효율이 낮은 순서대로 정렬해서 무조건 상위 3개를 뽑습니다.
  // (기존에는 warning 상태인 것만 찾아서 목록이 안 나왔음)
  const lowEfficiencyInverters = [...inverters]
    .sort((a, b) => a.efficiency - b.efficiency) // 오름차순 정렬 (낮은 게 먼저)
    .slice(0, 3); // 상위 3개 자르기

  // 차트 데이터 구성
  const chartData = {
    labels: inverters.map((inv) => inv.name.replace(' 인버터 #1', '')), // 이름 좀 짧게
    datasets: [
      {
        label: '현재 효율 (%)',
        data: inverters.map((inv) => inv.efficiency),
        backgroundColor: inverters.map((inv) => {
          if (inv.efficiency < 10) return '#ef4444'; // 10% 미만 빨강
          if (inv.efficiency < 50) return '#eab308'; // 50% 미만 노랑
          return '#22c55e'; // 그 외 초록
        }),
        borderRadius: 4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#fff',
        bodyColor: '#cbd5e1',
        borderColor: '#334155',
        borderWidth: 1,
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        grid: { color: '#334155' },
        ticks: { color: '#94a3b8' },
      },
      x: {
        grid: { display: false },
        ticks: {
          color: '#94a3b8',
          font: { size: 10 },
          maxRotation: 45,
          minRotation: 45,
        },
      },
    },
  };

  return (
    <div className="p-4 md:p-6 space-y-6 h-full overflow-y-auto pb-20 md:pb-6 custom-scrollbar">
      {/* 상단 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
          <div className="text-xs text-slate-400 mb-1">
            평균 효율 (Mean Eff)
          </div>
          <div className="text-2xl font-bold text-white">
            {stats.avg_efficiency || 0}
            <span className="text-sm font-normal text-slate-500 ml-1">%</span>
          </div>
          <div className="text-xs text-green-400 mt-2 flex items-center">
            <i className="fas fa-caret-up mr-1"></i> 2.1% (전년 대비)
          </div>
        </div>
        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
          <div className="text-xs text-slate-400 mb-1">일조 시간</div>
          <div className="text-2xl font-bold text-white">
            {stats.sunlight_hours || 0}
            <span className="text-sm font-normal text-slate-500 ml-1">Hr</span>
          </div>
          <div className="text-xs text-blue-400 mt-2">기상청 데이터 일치</div>
        </div>
        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
          <div className="text-xs text-slate-400 mb-1">총 탄소 저감량</div>
          <div className="text-2xl font-bold text-white">
            {stats.carbon_reduction || 0}
            <span className="text-sm font-normal text-slate-500 ml-1">ton</span>
          </div>
        </div>
        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
          <div className="text-xs text-slate-400 mb-1">설비 가동률</div>
          <div className="text-2xl font-bold text-white">
            {stats.operation_rate || 0}
            <span className="text-sm font-normal text-slate-500 ml-1">%</span>
          </div>
        </div>
      </div>

      {/* 메인 차트 및 리스트 영역 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[500px] lg:h-[400px]">
        {/* 왼쪽: 막대 차트 */}
        <div className="lg:col-span-2 bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg flex flex-col">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <i className="fas fa-chart-bar text-blue-500"></i> 인버터별 효율
            비교 분석
          </h3>
          <div className="flex-1 min-h-0 relative">
            <Bar data={chartData} options={chartOptions} />
          </div>
        </div>

        {/* 오른쪽: 효율 저하 Top 3 리스트 */}
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg flex flex-col">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            효율 저하 인버터 Top 3
          </h3>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-2">
            {lowEfficiencyInverters.length > 0 ? (
              lowEfficiencyInverters.map((inv) => (
                <div
                  key={inv.id}
                  className="bg-slate-900/50 p-3 rounded-lg border border-slate-700 flex flex-col gap-2"
                >
                  <div className="flex justify-between items-start">
                    <span className="text-sm font-bold text-slate-200">
                      {inv.name}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-bold ${
                        inv.efficiency < 10
                          ? 'bg-red-500/20 text-red-400'
                          : inv.efficiency < 50
                          ? 'bg-yellow-500/20 text-yellow-400'
                          : 'bg-green-500/20 text-green-400'
                      }`}
                    >
                      {inv.efficiency}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        inv.efficiency < 10
                          ? 'bg-red-500'
                          : inv.efficiency < 50
                          ? 'bg-yellow-500'
                          : 'bg-green-500'
                      }`}
                      style={{ width: `${inv.efficiency}%` }}
                    ></div>
                  </div>
                  <div className="text-[10px] text-slate-400 flex justify-between">
                    <span>용량: {inv.capacity}kW</span>
                    <span>상태: {inv.status}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 opacity-60">
                <i className="fas fa-check-circle text-4xl mb-2"></i>
                <p>모든 인버터 효율 양호</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
