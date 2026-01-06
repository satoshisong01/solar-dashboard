'use client';

interface MaintenanceTabProps {
  sites: any[];
  stats: any; // 건강 점수용
  schedule: any[]; // 일정 데이터용
}

export default function MaintenanceTab({
  sites,
  stats,
  schedule,
}: MaintenanceTabProps) {
  const errorSites = sites.filter((s) => s.is_error || s.status === 'warning');

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 설비 건강 점수 (DB: stats.health_score) */}
        <div className="bg-gradient-to-br from-indigo-900 to-slate-900 p-6 rounded-xl border border-indigo-500/30 text-center flex flex-col justify-center">
          <h3 className="text-lg font-bold text-white mb-2">
            전체 설비 건강 점수
          </h3>
          <div className="relative w-48 h-48 mx-auto my-6 flex items-center justify-center">
            <svg className="w-full h-full" viewBox="0 0 36 36">
              <path
                className="text-slate-700"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path
                className="text-indigo-500"
                strokeDasharray={`${stats?.health_score || 0}, 100`}
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              />
            </svg>
            <div className="absolute text-4xl font-bold text-white">
              {stats?.health_score || 0}
              <span className="text-lg font-normal text-slate-400">점</span>
            </div>
          </div>
          <p className="text-sm text-indigo-300">AI가 24시간 진단 중입니다.</p>
        </div>

        {/* AI 알림 테이블 (기존 동일) */}
        <div className="lg:col-span-2 bg-slate-800 p-6 rounded-xl border border-slate-700">
          {/* ... (기존 테이블 코드 동일) ... */}
          {/* 공간 절약을 위해 생략했습니다. 위 코드 그대로 쓰시면 됩니다. */}
          <h3 className="text-lg font-bold text-white mb-4">
            AI 고장 예측 알림
          </h3>
          <table className="w-full text-sm text-left text-slate-400">
            <thead className="text-xs text-slate-200 uppercase bg-slate-700">
              <tr>
                <th className="px-4 py-3">위치</th>
                <th className="px-4 py-3">문제</th>
                <th className="px-4 py-3">확률</th>
                <th className="px-4 py-3">조치</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {errorSites.map((site) => (
                <tr
                  key={site.id}
                  className={
                    site.is_error ? 'bg-red-900/20' : 'bg-yellow-900/10'
                  }
                >
                  <td className="px-4 py-4 text-white font-bold">
                    {site.name}
                  </td>
                  <td className="px-4 py-4 text-red-400">
                    {site.ai_msg.substring(0, 15)}...
                  </td>
                  <td className="px-4 py-4 text-red-500 font-bold">
                    {site.is_error ? '89%' : '65%'}
                  </td>
                  <td className="px-4 py-4">
                    <button className="bg-red-600 px-2 py-1 rounded text-white text-xs">
                      점검
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 스케줄러 (DB 데이터 기반 렌더링) */}
      <div className="mt-6 bg-slate-800 p-6 rounded-xl border border-slate-700">
        <h3 className="text-lg font-bold text-white mb-4">
          유지보수 일정 (Scheduler)
        </h3>
        <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-slate-600">
          {(schedule || []).map((item) => (
            <div
              key={item.id}
              className={`min-w-[200px] p-4 rounded-lg flex-shrink-0 
                ${
                  item.status === 'done'
                    ? 'bg-slate-700 opacity-50'
                    : item.status === 'today'
                    ? 'bg-blue-600 shadow-lg border-2 border-white'
                    : 'bg-slate-700'
                }`}
            >
              <div
                className={`text-xs ${
                  item.status === 'today' ? 'text-blue-200' : 'text-slate-400'
                }`}
              >
                {item.date_str}
              </div>
              <div className="font-bold text-white mt-1">{item.title}</div>
              <div
                className={`text-xs mt-2 ${
                  item.status === 'today' ? 'text-blue-200' : 'text-slate-400'
                }`}
              >
                {item.status === 'done' ? (
                  <i className="fas fa-check mr-1"></i>
                ) : null}
                {item.sub_text}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
