'use client';
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

interface RevenueTabProps {
  revenue: any[];
  market: any;
}

export default function RevenueTab({ revenue, market }: RevenueTabProps) {
  const safeRevenue = revenue || [];
  const currentMonthRevenue =
    safeRevenue.length > 0 ? safeRevenue[safeRevenue.length - 1].amount : 0;

  const smp = market?.SMP || { price: 0, change_val: 0 };
  const rec = market?.REC || { price: 0, change_val: 0 };

  return (
    <div className="h-full flex flex-col p-4 md:p-6 gap-4 md:gap-6 overflow-y-auto">
      {/* 1. 상단 요약 카드 (Grid) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 shrink-0">
        {/* 예상 수익 카드 */}
        <div className="bg-slate-800 p-5 md:p-6 rounded-xl border border-slate-700 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-400 text-xs md:text-sm font-bold uppercase">
                이번 달 예상 수익
              </div>
              <div className="text-2xl md:text-3xl font-bold text-white mt-2">
                ₩ {currentMonthRevenue.toLocaleString()}
              </div>
            </div>
            <div className="bg-yellow-500/20 w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center">
              <i className="fas fa-coins text-yellow-500 text-lg md:text-2xl"></i>
            </div>
          </div>
        </div>

        {/* SMP 카드 */}
        <div className="bg-slate-800 p-5 md:p-6 rounded-xl border border-slate-700 shadow-sm">
          <div className="text-slate-400 text-xs md:text-sm font-bold uppercase">
            SMP (계통한계가격)
          </div>
          <div className="text-xl md:text-2xl font-bold text-white mt-2">
            {smp.price}{' '}
            <span className="text-sm text-slate-500 font-normal">원/kWh</span>
          </div>
          <div
            className={`text-xs md:text-sm mt-1 font-bold ${
              smp.change_val > 0 ? 'text-green-400' : 'text-red-400'
            }`}
          >
            {smp.change_val > 0 ? '▲' : '▼'} {Math.abs(smp.change_val)}원{' '}
            <span className="text-slate-500 font-normal">(전일 대비)</span>
          </div>
        </div>

        {/* REC 카드 */}
        <div className="bg-slate-800 p-5 md:p-6 rounded-xl border border-slate-700 shadow-sm">
          <div className="text-slate-400 text-xs md:text-sm font-bold uppercase">
            REC (현물)
          </div>
          <div className="text-xl md:text-2xl font-bold text-white mt-2">
            {rec.price.toLocaleString()}{' '}
            <span className="text-sm text-slate-500 font-normal">원</span>
          </div>
          <div
            className={`text-xs md:text-sm mt-1 font-bold ${
              rec.change_val > 0 ? 'text-green-400' : 'text-red-400'
            }`}
          >
            {rec.change_val > 0 ? '▲' : '▼'} {Math.abs(rec.change_val)}원{' '}
            <span className="text-slate-500 font-normal">(전일 대비)</span>
          </div>
        </div>
      </div>

      {/* 2. 월별 수익 추이 차트 */}
      {/* 📱 모바일: 높이 350px / 💻 PC: 높이 500px */}
      <div className="bg-slate-800 p-4 md:p-6 rounded-xl border border-slate-700 h-[350px] md:h-[500px] flex flex-col mb-6">
        <h3 className="text-base md:text-lg font-bold text-white mb-4">
          월별 수익 추이
        </h3>
        <div className="relative w-full flex-1 min-h-0">
          <Line
            data={{
              labels: safeRevenue.map((r) => r.month),
              datasets: [
                {
                  label: '수익(만원)',
                  data: safeRevenue.map((r) => r.amount),
                  borderColor: '#3b82f6',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  fill: true,
                  tension: 0.4,
                  pointRadius: 4,
                  pointHoverRadius: 6,
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { display: false },
                tooltip: {
                  mode: 'index',
                  intersect: false,
                  backgroundColor: 'rgba(15, 23, 42, 0.9)',
                  titleColor: '#fff',
                  bodyColor: '#cbd5e1',
                  borderColor: '#334155',
                  borderWidth: 1,
                },
              },
              scales: {
                y: {
                  grid: { color: '#334155' },
                  ticks: { color: '#94a3b8', font: { size: 11 } },
                },
                x: {
                  grid: { color: '#334155' },
                  ticks: { color: '#94a3b8', font: { size: 11 } },
                },
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
