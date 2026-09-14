// "안전감시 공백" 판정. 순수 함수 (now 주입). 서버·클라이언트 공용.
// 수소·ESS 설비가 있는 사이트는 통신이 끊기면 안전 이벤트도 받지 못하므로, 게이트웨이 무수신을 안전 화면에 따로 드러낸다.
// 콘솔은 인터록을 대체하지 않는다: 이 표시는 "안전 데이터가 불확실하다"는 뜻일 뿐이다 (설계 §3 안전 레인).
import { domainOfClass, type EquipmentDomain } from './domains';

/** 통신 두절 시 안전 데이터가 불확실해지는 설비 도메인 */
const SAFETY_DOMAINS: ReadonlySet<EquipmentDomain> = new Set(['ess', 'electrolyzer', 'storage', 'fuelcell']);

export interface SilenceSite {
  readonly siteId: number;
  readonly siteCode: string;
  /** 사이트에 있는 설비 종류 키 (중복 허용) */
  readonly classKeys: readonly string[];
}

export interface SilenceGateway {
  readonly siteId: number;
  readonly code: string;
  readonly status: string;
  readonly lastSeenMs: number | null;
}

export type SilenceGap =
  | Readonly<{ kind: 'no_gateway'; siteCode: string }>
  | Readonly<{ kind: 'never_seen'; siteCode: string; gatewayCode: string }>
  | Readonly<{ kind: 'silent'; siteCode: string; gatewayCode: string; lastSeenMs: number; silentMs: number }>;

/** 사이트가 수소(전해조·저장·연료전지) 또는 ESS 설비를 갖고 있는가 */
export function hasSafetyCriticalAssets(classKeys: readonly string[]): boolean {
  return classKeys.some((key) => {
    const domain = domainOfClass(key);
    return domain !== null && SAFETY_DOMAINS.has(domain);
  });
}

/**
 * 안전 대상 사이트마다: 활성 게이트웨이가 없으면 no_gateway, 수신 기록이 없으면 never_seen,
 * 마지막 수신 뒤 silenceMs 이상 지났으면 silent. 비활성 게이트웨이는 보지 않는다.
 * 결과는 사이트 코드 → 게이트웨이 코드 순.
 */
export function findSafetySilence(
  sites: readonly SilenceSite[],
  gateways: readonly SilenceGateway[],
  nowMs: number,
  silenceMs: number,
): readonly SilenceGap[] {
  if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new Error(`silenceMs는 0보다 커야 합니다: ${silenceMs}`);

  const watched = sites.filter((site) => hasSafetyCriticalAssets(site.classKeys)).sort((a, b) => a.siteCode.localeCompare(b.siteCode));
  return watched.flatMap((site): SilenceGap[] => {
    const active = gateways
      .filter((gateway) => gateway.siteId === site.siteId && gateway.status === 'active')
      .sort((a, b) => a.code.localeCompare(b.code));
    if (active.length === 0) return [{ kind: 'no_gateway', siteCode: site.siteCode }];

    return active.flatMap((gateway): SilenceGap[] => {
      if (gateway.lastSeenMs === null) return [{ kind: 'never_seen', siteCode: site.siteCode, gatewayCode: gateway.code }];
      const silentMs = nowMs - gateway.lastSeenMs;
      if (silentMs < silenceMs) return [];
      return [{ kind: 'silent', siteCode: site.siteCode, gatewayCode: gateway.code, lastSeenMs: gateway.lastSeenMs, silentMs }];
    });
  });
}
