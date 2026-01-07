'use client';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
);

interface MaintenanceTabProps {
  sites: any[];
  stats: any;
  schedule: any[];
}

export default function MaintenanceTab({
  sites,
  stats,
  schedule,
}: MaintenanceTabProps) {
  // 1. 상태별 사이트 분류
  const errorSites = sites.filter((s) => s.is_error);
  const warningSites = sites.filter(
    (s) => !s.is_error && s.status === 'warning'
  );
  const normalSites = sites.filter(
    (s) => !s.is_error && s.status !== 'warning'
  );

  // 2. 도넛 차트 데이터
  const statusData = {
    labels: ['정상 가동', '점검 필요(Warn)', '고장/중단(Crit)'],
    datasets: [
      {
        data: [normalSites.length, warningSites.length, errorSites.length],
        backgroundColor: ['#22c55e', '#eab308', '#ef4444'],
        borderColor: ['#1e293b', '#1e293b', '#1e293b'],
        borderWidth: 2,
      },
    ],
  };

  // 3. 막대 차트 데이터
  const failureTypeData = {
    labels: ['인버터 과열', '패널 파손', '접속반 오류', '통신 장애', '기타'],
    datasets: [
      {
        label: '발생 건수',
        data: [12, 5, 8, 3, 2],
        backgroundColor: 'rgba(59, 130, 246, 0.5)',
        borderColor: '#3b82f6',
        borderWidth: 1,
      },
    ],
  };

  return (
    <div className="h-full flex flex-col p-6 gap-6 overflow-y-auto">
      {/* 상단 헤더: 요약 카드 */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-slate-800 border border-slate-700 p-4 rounded-xl">
          <div className="text-slate-400 text-xs uppercase font-bold mb-1">
            전체 설비
          </div>
          <div className="text-2xl font-bold text-white">
            {sites.length}{' '}
            <span className="text-sm font-normal text-slate-500">개소</span>
          </div>
        </div>
        <div className="bg-slate-800 border border-green-900/50 p-4 rounded-xl">
          <div className="text-green-400 text-xs uppercase font-bold mb-1">
            정상 가동
          </div>
          <div className="text-2xl font-bold text-green-400">
            {normalSites.length}
          </div>
        </div>
        <div className="bg-slate-800 border border-yellow-900/50 p-4 rounded-xl">
          <div className="text-yellow-400 text-xs uppercase font-bold mb-1">
            점검 요망
          </div>
          <div className="text-2xl font-bold text-yellow-400">
            {warningSites.length}
          </div>
        </div>
        <div className="bg-slate-800 border border-red-900/50 p-4 rounded-xl">
          <div className="text-red-400 text-xs uppercase font-bold mb-1">
            긴급 조치
          </div>
          <div className="text-2xl font-bold text-red-400">
            {errorSites.length}
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-3 gap-6 min-h-0">
        {/* 왼쪽 2열: 점검 리스트 */}
        <div className="col-span-2 flex flex-col gap-6">
          {/* 1. 긴급 조치 리스트 */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 flex-1 flex flex-col">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <i className="fas fa-tools text-red-400"></i> 우선 점검 대상
              (Priority Tasks)
            </h3>

            <div className="flex-1 overflow-y-auto pr-2 space-y-3">
              {[...errorSites, ...warningSites].length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500">
                  <i className="fas fa-check-circle text-4xl mb-2 text-slate-600"></i>
                  <p>현재 점검이 필요한 설비가 없습니다.</p>
                </div>
              ) : (
                [...errorSites, ...warningSites].map((site) => (
                  <div
                    key={site.id}
                    className={`p-4 rounded-lg border flex justify-between items-center ${
                      site.is_error
                        ? 'bg-red-900/10 border-red-900/50'
                        : 'bg-yellow-900/10 border-yellow-900/50'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${
                          site.is_error
                            ? 'bg-red-500 text-white'
                            : 'bg-yellow-500 text-white'
                        }`}
                      >
                        <i className="fas fa-exclamation-triangle"></i>
                      </div>
                      <div>
                        <div className="font-bold text-slate-200 text-lg flex items-center gap-2">
                          {site.name}
                          {site.fail_date && (
                            <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded animate-pulse">
                              <i className="fas fa-stopwatch mr-1"></i>
                              {site.fail_date} 고장 예상
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-slate-400 mt-1">
                          {site.ai_msg}
                        </div>
                        {site.loss_amt && site.loss_amt !== '0' && (
                          <div className="text-xs text-red-300 mt-1 font-bold">
                            예상 손실비용: {site.loss_amt}원/h
                          </div>
                        )}
                      </div>
                    </div>
                    <button className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm transition-colors">
                      조치 보고서 작성
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 2. 정기 점검 일정 */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 h-64 flex flex-col mb-5">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <i className="fas fa-calendar-alt text-blue-400"></i> 향후 정기
              점검 일정
            </h3>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm text-left text-slate-400">
                <thead className="text-xs text-slate-500 uppercase bg-slate-900/50">
                  <tr>
                    <th className="px-4 py-3">날짜</th>
                    <th className="px-4 py-3">대상</th>
                    <th className="px-4 py-3">작업 내용</th>
                    <th className="px-4 py-3">담당자</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule && schedule.length > 0 ? (
                    schedule.map((item, idx) => (
                      <tr
                        key={idx}
                        className="border-b border-slate-700/50 hover:bg-slate-700/30"
                      >
                        <td className="px-4 py-3 font-medium text-slate-300">
                          {item.date}
                        </td>
                        <td className="px-4 py-3">{item.target}</td>
                        <td className="px-4 py-3">{item.content}</td>
                        <td className="px-4 py-3">{item.manager}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="text-center py-4">
                        일정 데이터 없음
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 오른쪽 1열: 통계 차트 */}
        <div className="col-span-1 flex flex-col gap-6">
          {/* 상태 비율 (도넛) */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 h-64">
            <h3 className="text-sm font-bold text-slate-300 mb-4">
              설비 상태 비율
            </h3>
            <div className="relative h-40 w-full flex justify-center">
              <Doughnut
                data={statusData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: 'right',
                      labels: { color: '#94a3b8', boxWidth: 10 },
                    },
                  },
                }}
              />
            </div>
          </div>

          {/* 🔴 [수정됨] 고장 유형 분석 (막대) - flex-1 제거하고 h-64로 고정 */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 h-64">
            <h3 className="text-sm font-bold text-slate-300 mb-4">
              주요 고장 유형 분석
            </h3>
            <div className="relative h-full w-full">
              <Bar
                data={failureTypeData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: {
                    y: {
                      grid: { color: '#334155' },
                      ticks: { color: '#94a3b8' },
                    },
                    x: {
                      grid: { display: false },
                      ticks: { color: '#94a3b8' },
                    },
                  },
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
