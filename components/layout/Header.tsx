'use client';

interface HeaderProps {
  activeTab: string;
}

export default function Header({ activeTab }: HeaderProps) {
  const titles: Record<string, string> = {
    map: '실시간 발전소 통합 모니터링',
    efficiency: '발전 효율 상세 분석',
    maintenance: 'AI 기반 예지 보전',
    revenue: '수익 및 매전 정산 관리',
  };

  return (
    <header className="h-16 border-b border-slate-700 flex justify-between items-center px-6 z-20 bg-slate-900 flex-shrink-0">
      <h2 className="text-lg font-bold text-white">{titles[activeTab]}</h2>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1 bg-slate-800 rounded-full text-sm">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          <span className="text-slate-200">AI Analysis Active</span>
        </div>
        <div className="text-slate-400 text-sm">
          <i className="far fa-clock mr-1"></i> 2026-01-06
        </div>
      </div>
    </header>
  );
}
