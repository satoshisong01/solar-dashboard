// 설비 종류(asset_class.key) → 화면 도메인. 순수 모듈 (서버·클라이언트 공용).

export type EquipmentDomain = 'pv' | 'ess' | 'electrolyzer' | 'storage' | 'fuelcell';
export type FleetColumn = EquipmentDomain | 'dq';

export const EQUIPMENT_DOMAINS: readonly Readonly<{ key: EquipmentDomain; label: string }>[] = [
  { key: 'pv', label: 'PV' },
  { key: 'ess', label: 'ESS' },
  { key: 'electrolyzer', label: '전해조' },
  { key: 'storage', label: '저장' },
  { key: 'fuelcell', label: '연료전지' },
];

export const FLEET_COLUMNS: readonly Readonly<{ key: FleetColumn; label: string }>[] = [
  ...EQUIPMENT_DOMAINS,
  { key: 'dq', label: '데이터품질' },
];

/** 기상관측은 PV 판단에 쓰므로 PV에 넣는다. 계통 계량기처럼 어느 도메인에도 속하지 않으면 null (데이터품질에는 포함) */
export function domainOfClass(classKey: string): EquipmentDomain | null {
  if (classKey.startsWith('pv.') || classKey.startsWith('wx.')) return 'pv';
  if (classKey.startsWith('ess.')) return 'ess';
  if (classKey === 'h2.elz' || classKey.startsWith('h2.elz.')) return 'electrolyzer';
  if (classKey === 'h2.compressor' || classKey === 'h2.detector' || classKey.startsWith('h2.storage.')) return 'storage';
  if (classKey.startsWith('fc.')) return 'fuelcell';
  return null;
}

export type ChartTone = 'solar' | 'hydrogen' | 'neutral';

/** 차트 계열 색 계열: 태양광(앰버) · 수소(틸) · 그 밖(중립) */
export function toneOfClass(classKey: string): ChartTone {
  const domain = domainOfClass(classKey);
  if (domain === 'pv') return 'solar';
  if (domain === 'electrolyzer' || domain === 'storage' || domain === 'fuelcell') return 'hydrogen';
  return 'neutral';
}

export const ASSET_LEVEL_LABELS: Readonly<Record<string, string>> = {
  system: '계통',
  asset: '설비',
  component: '부품',
};
