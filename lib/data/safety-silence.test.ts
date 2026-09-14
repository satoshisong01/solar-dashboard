import { describe, expect, it } from 'vitest';
import { findSafetySilence, hasSafetyCriticalAssets, type SilenceGateway, type SilenceSite } from './safety-silence';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const MINUTE = 60_000;
const SILENCE = 10 * MINUTE;

const PV_ONLY: SilenceSite = { siteId: 1, siteCode: 'SITE-PV', classKeys: ['pv.plant', 'pv.inverter', 'wx.station', 'grid.meter'] };
const PV_ESS: SilenceSite = { siteId: 2, siteCode: 'SIM-A', classKeys: ['pv.plant', 'ess.plant', 'ess.rack'] };
const HYDROGEN: SilenceSite = { siteId: 3, siteCode: 'SIM-B', classKeys: ['h2.elz', 'h2.compressor', 'fc.stack'] };

const gw = (siteId: number, code: string, lastSeenMs: number | null, status = 'active'): SilenceGateway => ({ siteId, code, status, lastSeenMs });

describe('hasSafetyCriticalAssets', () => {
  it('ESS·전해조·저장·연료전지 설비가 있으면 true, 태양광·기상·계량기만 있으면 false', () => {
    expect(hasSafetyCriticalAssets(PV_ONLY.classKeys)).toBe(false);
    expect(hasSafetyCriticalAssets(PV_ESS.classKeys)).toBe(true);
    expect(hasSafetyCriticalAssets(['h2.detector'])).toBe(true);
    expect(hasSafetyCriticalAssets(['h2.storage.bank'])).toBe(true);
    expect(hasSafetyCriticalAssets(['fc.plant'])).toBe(true);
    expect(hasSafetyCriticalAssets([])).toBe(false);
  });
});

describe('findSafetySilence', () => {
  it('경계값: 무수신 10분 미만은 공백이 아니고, 10분 이상이면 공백', () => {
    expect(findSafetySilence([PV_ESS], [gw(2, 'GW-A', NOW - SILENCE + 1)], NOW, SILENCE)).toEqual([]);
    expect(findSafetySilence([PV_ESS], [gw(2, 'GW-A', NOW - SILENCE)], NOW, SILENCE)).toEqual([
      { kind: 'silent', siteCode: 'SIM-A', gatewayCode: 'GW-A', lastSeenMs: NOW - SILENCE, silentMs: SILENCE },
    ]);
  });

  it('수소·ESS 설비가 없는 사이트의 게이트웨이는 오래 끊겨도 보지 않는다', () => {
    expect(findSafetySilence([PV_ONLY], [gw(1, 'GW-PV', NOW - 24 * 60 * MINUTE)], NOW, SILENCE)).toEqual([]);
  });

  it('수신 기록이 없는 활성 게이트웨이와 활성 게이트웨이가 없는 사이트도 공백이다', () => {
    const gaps = findSafetySilence([HYDROGEN, PV_ESS], [gw(3, 'GW-B', null), gw(2, 'GW-A-OLD', NOW - 60 * MINUTE, 'disabled')], NOW, SILENCE);
    expect(gaps).toEqual([
      { kind: 'no_gateway', siteCode: 'SIM-A' },
      { kind: 'never_seen', siteCode: 'SIM-B', gatewayCode: 'GW-B' },
    ]);
  });

  it('게이트웨이마다 따로 판정하고 사이트 → 게이트웨이 코드 순으로 돌려준다', () => {
    const gaps = findSafetySilence(
      [HYDROGEN, PV_ESS],
      [gw(3, 'GW-B-02', NOW - 30 * MINUTE), gw(3, 'GW-B-01', NOW - MINUTE), gw(2, 'GW-A', NOW - 11 * MINUTE)],
      NOW,
      SILENCE,
    );
    const labels = gaps.map((gap) => (gap.kind === 'no_gateway' ? gap.siteCode : `${gap.siteCode}/${gap.gatewayCode}`));
    expect(labels).toEqual(['SIM-A/GW-A', 'SIM-B/GW-B-02']);
  });

  it('마지막 수신이 서버 시각보다 미래(시계 오차)면 공백이 아니다', () => {
    expect(findSafetySilence([PV_ESS], [gw(2, 'GW-A', NOW + 5 * MINUTE)], NOW, SILENCE)).toEqual([]);
  });

  it('기준 시간이 0 이하이면 오류', () => {
    expect(() => findSafetySilence([PV_ESS], [], NOW, 0)).toThrow('silenceMs');
  });
});
