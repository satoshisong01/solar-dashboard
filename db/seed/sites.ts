// 시드가 DB에 넣는 사이트: 가상 3곳(SIM-A/B/C)과 실사이트 1곳(GP-1 가평). 순수 데이터 모듈 ('server-only' 금지).
// 시뮬레이터(lib/sim)는 SIM_SITES만 본다 — 실사이트에 가짜 데이터를 넣지 않기 위해서다 (simulatorSites 참고).
import { buildAssets, SLOW_PERIOD_S, type AssetSpec, type SiteContext } from './asset-spec';
import { GAPYEONG_PLANNED_POINTS, gapyeongAssets } from './templates-gapyeong';
import { electrolyzerPlant, fuelCellPlant, hydrogenStorage } from './templates-hydrogen';
import { essPlant, pvPlant, siteCommon } from './templates-solar';
import type { GatewayDef, PlannedPointDef, SiteDef, UnmappedTagDef } from './types';

const SITE_TIMEZONE = 'Asia/Seoul';

/** 게이트웨이 코드 → 개발용 HMAC 비밀값 환경변수 이름 (예: GW-SIMA-01 → SIM_GATEWAY_SECRET_GW_SIMA_01) */
export function gatewaySecretEnvVar(gatewayCode: string): string {
  return `SIM_GATEWAY_SECRET_${gatewayCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** 사이트마다 게이트웨이 1개와 개발용 키 1개 (예: SIM-A → GW-SIMA-01, gk_sim-a_dev) */
function devGateway(siteCode: string): GatewayDef {
  const code = `GW-${siteCode.replace(/-/g, '')}-01`;
  return { code, keyId: `gk_${siteCode.toLowerCase()}_dev`, secretEnvVar: gatewaySecretEnvVar(code) };
}

/**
 * 게이트웨이가 보내지만 일부러 point를 만들지 않는 태그 (미매핑 인박스 → 매핑 → 재처리 시연용).
 * 시드는 이 태그를 DB에 넣지 않는다. 수집 시 om.unmapped_source에 쌓인다.
 */
export const UNMAPPED_SOURCE_TAGS: Readonly<Record<string, readonly UnmappedTagDef[]>> = {
  'SIM-B': [
    { sourceKey: 'ELZ1/DRYER/DEWPOINT', unit: '°C', periodS: SLOW_PERIOD_S, assetCode: 'ELZ1/DRYER', metricKey: 'h2.dewpoint' },
    { sourceKey: 'COMP1/VIB_RMS', unit: 'mm/s', periodS: SLOW_PERIOD_S, assetCode: 'COMP1', metricKey: 'vibration.rms' },
  ],
};

interface SiteSpec {
  readonly code: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** 준공 전이면 null */
  readonly commissionedAt: string | null;
  readonly attributes: SiteDef['attributes'];
  readonly assets: readonly AssetSpec[];
  readonly plannedPoints?: readonly PlannedPointDef[];
}

function buildSite(spec: SiteSpec): SiteDef {
  const ctx: SiteContext = { siteCode: spec.code, commissionedAt: spec.commissionedAt };
  return {
    code: spec.code,
    name: spec.name,
    lat: spec.lat,
    lon: spec.lon,
    timezone: SITE_TIMEZONE,
    attributes: spec.attributes,
    gateway: devGateway(spec.code),
    assets: buildAssets(ctx, spec.assets),
    unmappedTags: UNMAPPED_SOURCE_TAGS[spec.code] ?? [],
    plannedPoints: spec.plannedPoints ?? [],
  };
}

/** 연계형: PV 2 MWp(인버터 4) + ESS 1 MWh(랙 2) + PEM 전해조 500 kW + 압축·저장 + PEMFC 200 kW */
function integratedAssets(): readonly AssetSpec[] {
  return [
    ...pvPlant(2_000, 4, false),
    ...essPlant(1_000, 500, 2),
    ...electrolyzerPlant(),
    ...hydrogenStorage(),
    ...fuelCellPlant(),
    ...siteCommon(2_000),
  ];
}

const SIMULATED_SITES: readonly SiteDef[] = [
  buildSite({
    code: 'SIM-A',
    name: '영암 태양광·ESS',
    lat: 34.8,
    lon: 126.7,
    commissionedAt: '2025-03-01',
    attributes: { simulated: true, layout: 'pv_ess', control_group: false },
    // PV 1 MWp(인버터 4대, 인버터당 MPPT 2) + ESS 2 MWh(PCS 1, 랙 4) + 기상 1 + 계량기 1
    assets: [...pvPlant(1_000, 4, true), ...essPlant(2_000, 1_000, 4), ...siteCommon(1_000)],
  }),
  buildSite({
    code: 'SIM-B',
    name: '새만금 연계형',
    lat: 35.85,
    lon: 126.55,
    commissionedAt: '2025-09-01',
    attributes: { simulated: true, layout: 'integrated', control_group: false },
    assets: integratedAssets(),
  }),
  buildSite({
    code: 'SIM-C',
    name: '제주 연계형(대조군)',
    lat: 33.36,
    lon: 126.53,
    commissionedAt: '2025-09-01',
    // SIM-B와 같은 구성. 시뮬레이터가 고장을 주입하지 않는 음성 대조군이다.
    attributes: { simulated: true, layout: 'integrated', control_group: true },
    assets: integratedAssets(),
  }),
];

/**
 * 실사이트: 가평 2MW 청정수소발전 (도면 FCND-GP-PID-002 REV.2).
 * simulated: false가 시뮬레이터 차단 표시다. 설비·명판은 db/seed/templates-gapyeong.ts 참고.
 */
const GAPYEONG_SITE: SiteDef = buildSite({
  code: 'GP-1',
  name: '가평 2MW 청정수소발전',
  lat: 37.83,
  lon: 127.51,
  commissionedAt: null, // 준공 전 — 기준선 시작일이 없다
  attributes: { simulated: false, layout: 'integrated', control_group: false, pid_rev: 'FCND-GP-PID-002 REV.2' },
  assets: gapyeongAssets(),
  plannedPoints: GAPYEONG_PLANNED_POINTS,
});

/** npm run db:seed가 DB에 넣는 사이트 전부 */
export const SEED_SITES: readonly SiteDef[] = [...SIMULATED_SITES, GAPYEONG_SITE];

/** 시뮬레이터가 데이터를 넣어도 되는 사이트 (attributes.simulated) */
export const SIM_SITES: readonly SiteDef[] = SEED_SITES.filter((site) => site.attributes.simulated === true);

/**
 * 시뮬레이터 대상 사이트. 실사이트는 기본으로 막고 설정(includeRealSites)으로만 연다 —
 * 데모 데이터를 넣을 때만 켜고, 평소에는 실사이트에 가짜 값이 들어가지 않게 한다.
 */
export function simulatorSites({ includeRealSites = false }: { readonly includeRealSites?: boolean } = {}): readonly SiteDef[] {
  return includeRealSites ? SEED_SITES : SIM_SITES;
}
