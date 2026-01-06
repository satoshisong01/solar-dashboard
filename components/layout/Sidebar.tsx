'use client';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  totalGen: string;
}

export default function Sidebar({
  activeTab,
  onTabChange,
  totalGen,
}: SidebarProps) {
  const tabs = [
    { id: 'map', label: '통합 관제 (Map)', icon: 'fa-map-marked-alt' },
    { id: 'efficiency', label: '발전 효율 분석', icon: 'fa-chart-line' },
    { id: 'maintenance', label: '예지 보전 (AI)', icon: 'fa-tools' },
    { id: 'revenue', label: '수익/매전 관리', icon: 'fa-file-invoice-dollar' },
  ];

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-700 flex flex-col z-20 flex-shrink-0">
      <div className="p-6 flex items-center gap-3">
        <i className="fas fa-solar-panel text-blue-400 text-2xl"></i>
        <span className="text-xl font-bold text-white">
          SolarAI <span className="text-xs text-blue-400 font-normal">EMS</span>
        </span>
      </div>
      <nav className="flex-1 px-4 space-y-2 mt-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`w-full flex items-center px-4 py-3 rounded-lg transition cursor-pointer ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <i className={`fas ${tab.icon} w-6`}></i> {tab.label}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-slate-700">
        <div className="bg-slate-800 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Total Power Gen</div>
          <div className="text-xl font-bold text-green-400">{totalGen} kW</div>
          <div className="text-xs text-slate-500 mt-1">▲ 12% vs AI 예측</div>
        </div>
      </div>
    </aside>
  );
}
