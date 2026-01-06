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

// ✨ 여기 이름을 확인하세요! (MaintenanceTabProps가 아니어야 합니다)
interface RevenueTabProps {
  revenue: any[];
  market: any;
}

// ✨ 컴포넌트가 RevenueTabProps를 받는지 확인하세요!
export default function RevenueTab({ revenue, market }: RevenueTabProps) {
  const safeRevenue = revenue || [];
  const currentMonthRevenue =
    safeRevenue.length > 0 ? safeRevenue[safeRevenue.length - 1].amount : 0;

  const smp = market?.SMP || { price: 0, change_val: 0 };
  const rec = market?.REC || { price: 0, change_val: 0 };

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-400 text-sm">이번 달 예상 수익</div>
              <div className="text-3xl font-bold text-white mt-2">
                ₩ {currentMonthRevenue.toLocaleString()},000
              </div>
            </div>
            <div className="bg-yellow-500/20 p-3 rounded-full">
              <i className="fas fa-coins text-yellow-500 text-2xl"></i>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">SMP (계통한계가격)</div>
          <div className="text-2xl font-bold text-white mt-2">
            {smp.price} <span className="text-sm text-slate-500">원/kWh</span>
          </div>
          <div
            className={`text-xs mt-1 ${
              smp.change_val > 0 ? 'text-green-400' : 'text-red-400'
            }`}
          >
            {smp.change_val > 0 ? '▲' : '▼'} {Math.abs(smp.change_val)}원 (전일
            대비)
          </div>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
          <div className="text-slate-400 text-sm">REC (현물)</div>
          <div className="text-2xl font-bold text-white mt-2">
            {rec.price.toLocaleString()}{' '}
            <span className="text-sm text-slate-500">원</span>
          </div>
          <div
            className={`text-xs mt-1 ${
              rec.change_val > 0 ? 'text-green-400' : 'text-red-400'
            }`}
          >
            {rec.change_val > 0 ? '▲' : '▼'} {Math.abs(rec.change_val)}원 (전일
            대비)
          </div>
        </div>
      </div>
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 h-[500px]">
        <h3 className="text-lg font-bold text-white mb-4">월별 수익 추이</h3>
        <div className="relative w-full h-full pb-10">
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
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: { grid: { color: '#334155' } },
                x: { grid: { color: '#334155' } },
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
