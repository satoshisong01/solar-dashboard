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
  // 감압밸브·외부 반입은 저장·공급 쪽, 폐열회수 열교환기는 연료전지 부속, 부산물 산소는 전해조 부속으로 본다
  if (classKey === 'h2.prv' || classKey === 'h2.delivery' || classKey === 'h2.trailer') return 'storage';
  if (classKey.startsWith('o2.')) return 'electrolyzer';
  if (classKey.startsWith('fc.') || classKey.startsWith('hx.')) return 'fuelcell';
  return null;
}

/** 지도 마커·패널이 보여 주는 사이트 설비 구성 (전해조·저장·연료전지는 '수소' 하나로 묶는다) */
export type SiteDomain = 'pv' | 'ess' | 'h2';

export const SITE_DOMAIN_LABELS: Readonly<Record<SiteDomain, string>> = { pv: '태양광', ess: 'ESS', h2: '수소' };

/** 사이트가 가진 설비 종류 키 → 지도용 도메인 목록 (pv → ess → h2 순) */
export function siteDomainsOf(classKeys: readonly string[]): readonly SiteDomain[] {
  const found = new Set<SiteDomain>();
  for (const key of classKeys) {
    const domain = domainOfClass(key);
    if (domain === 'pv') found.add('pv');
    else if (domain === 'ess') found.add('ess');
    else if (domain !== null) found.add('h2');
  }
  return (['pv', 'ess', 'h2'] as const).filter((domain) => found.has(domain));
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

/**
 * 사이트 단위 발견사항(설비 없음)의 도메인: 탐지기로 정한다.
 * 태양광 오염 → PV, 수소 물질수지 잔차 → 저장(물질수지는 저장량 증감으로 닫히고 누설 교차 확인도 저장부다). 모르는 탐지기는 null
 */
export function domainOfSiteDetector(detectorId: string): EquipmentDomain | null {
  if (detectorId === 'pv.soiling_rate') return 'pv';
  if (detectorId === 'h2chain.mass_balance_gap') return 'storage';
  return null;
}
