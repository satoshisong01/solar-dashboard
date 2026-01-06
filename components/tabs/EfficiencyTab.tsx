'use client';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

interface EfficiencyTabProps {
  inverters: any[];
  stats: any; // DB에서 가져온 stats 객체
}

export default function EfficiencyTab({
  inverters,
  stats,
}: EfficiencyTabProps) {
  const safeInverters = inverters || [];

  // 평균 효율 (DB의 인버터 데이터로 실시간 계산)
  const avgEfficiency =
    safeInverters.length > 0
      ? (
          safeInverters.reduce((acc, curr) => acc + curr.efficiency, 0) /
          safeInverters.length
        ).toFixed(1)
      : '0';

  const lowEffInverters = [...safeInverters]
    .filter((inv) => inv.status !== 'normal')
    .sort((a, b) => a.efficiency - b.efficiency);

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
        {/* 평균 효율 (계산값) */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">평균 효율 (Mean Eff)</div>
          <div className="text-3xl font-bold text-white mt-2">
            {avgEfficiency} <span className="text-sm text-slate-500">%</span>
          </div>
          <div className="text-xs text-green-400 mt-1">▲ 2.1% (전년 대비)</div>
        </div>

        {/* 일조 시간 (DB: stats.sunlight_hours) */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">일조 시간</div>
          <div className="text-3xl font-bold text-white mt-2">
            {stats?.sunlight_hours || '-'}{' '}
            <span className="text-sm text-slate-500">Hr</span>
          </div>
          <div className="text-xs text-blue-400 mt-1">기상청 데이터 일치</div>
        </div>

        {/* 탄소 저감량 (DB: stats.carbon_reduction) */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">총 탄소 저감량</div>
          <div className="text-3xl font-bold text-white mt-2">
            {stats?.carbon_reduction
              ? stats.carbon_reduction.toLocaleString()
              : '-'}{' '}
            <span className="text-sm text-slate-500">ton</span>
          </div>
        </div>

        {/* 설비 가동률 (DB: stats.operation_rate) */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">설비 가동률</div>
          <div className="text-3xl font-bold text-white mt-2">
            {stats?.operation_rate || '-'}{' '}
            <span className="text-sm text-slate-500">%</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[500px]">
        {/* 차트 영역 (기존 동일) */}
        <div className="lg:col-span-2 bg-slate-800 p-6 rounded-xl border border-slate-700 flex flex-col">
          <h3 className="text-lg font-bold text-white mb-4">
            <i className="fas fa-chart-bar mr-2 text-blue-500"></i>인버터별 효율
            비교 분석
          </h3>
          <div className="flex-1 relative">
            <Bar
              data={{
                labels: safeInverters.map((i) => i.name),
                datasets: [
                  {
                    label: '효율(%)',
                    data: safeInverters.map((i) => i.efficiency),
                    backgroundColor: safeInverters.map((i) =>
                      i.efficiency < 50
                        ? '#ef4444'
                        : i.efficiency < 85
                        ? '#eab308'
                        : '#22c55e'
                    ),
                    borderRadius: 4,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                  y: { min: 0, max: 100, grid: { color: '#334155' } },
                  x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
                },
              }}
            />
          </div>
        </div>

        {/* 리스트 영역 (기존 동일) */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 overflow-y-auto">
          <h3 className="text-lg font-bold text-white mb-4">
            효율 저하 인버터 Top 3
          </h3>
          <div className="space-y-4">
            {lowEffInverters.map((inv) => (
              <div
                key={inv.id}
                className="bg-slate-900 p-4 rounded-lg border border-slate-700"
              >
                <div className="flex justify-between mb-1">
                  <span
                    className={`text-sm font-bold ${
                      inv.status === 'critical'
                        ? 'text-red-400'
                        : 'text-yellow-400'
                    }`}
                  >
                    {inv.name}
                  </span>
                  <span
                    className={`text-xs font-bold ${
                      inv.status === 'critical'
                        ? 'text-red-500'
                        : 'text-yellow-500'
                    }`}
                  >
                    {inv.efficiency}%
                  </span>
                </div>
                <div className="w-full bg-slate-700 h-2 rounded-full">
                  <div
                    className={`h-2 rounded-full ${
                      inv.status === 'critical' ? 'bg-red-500' : 'bg-yellow-500'
                    }`}
                    style={{ width: `${inv.efficiency}%` }}
                  ></div>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  원인: {inv.reason}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
