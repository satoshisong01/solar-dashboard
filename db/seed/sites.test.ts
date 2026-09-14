import { describe, expect, it } from 'vitest';
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from './catalog';
import { gatewaySecretEnvVar, SIM_SITES, UNMAPPED_SOURCE_TAGS } from './sites';
import type { AssetDef, SiteDef } from './types';

function site(code: string): SiteDef {
  const found = SIM_SITES.find((candidate) => candidate.code === code);
  if (!found) throw new Error(`사이트 없음: ${code}`);
  return found;
}

const countByClass = (s: SiteDef, classKey: string) => s.assets.filter((a) => a.classKey === classKey).length;
const sumNameplate = (s: SiteDef, classKey: string, field: string) =>
  s.assets.filter((a) => a.classKey === classKey).reduce((sum, a) => sum + Number(a.nameplate[field]), 0);
const parentCode = (asset: AssetDef) => (asset.code.includes('/') ? asset.code.slice(0, asset.code.lastIndexOf('/')) : null);

/** 60초 주기로 받을 (설비 종류, 메트릭). 나머지는 300초. */
const FAST_POINTS: Readonly<Record<string, readonly string[]>> = {
  'ess.rack': ['batt.current', 'batt.voltage', 'batt.soc', 'cell.voltage.max', 'cell.voltage.min', 'cell.voltage.avg', 'cell.temp.max', 'cell.temp.min', 'cell.temp.avg'],
  'h2.elz.stack': ['stack.voltage', 'stack.current'],
  'fc.stack': ['stack.voltage', 'stack.current'],
  'pv.inverter': ['ac.power', 'dc.power'],
};

describe('SIM_SITES 구성', () => {
  it('SIM-A/B/C 세 곳을 좌표와 함께 정의한다', () => {
    expect(SIM_SITES.map((s) => [s.code, s.name, s.lat, s.lon])).toEqual([
      ['SIM-A', '영암 태양광·ESS', 34.8, 126.7],
      ['SIM-B', '새만금 연계형', 35.85, 126.55],
      ['SIM-C', '제주 연계형(대조군)', 33.36, 126.53],
    ]);
  });

  it('SIM-A: PV 1 MWp(인버터 4, MPPT 8) + ESS 2 MWh(PCS 1, 랙 4) + 기상 1 + 계량기 1', () => {
    const simA = site('SIM-A');

    expect(countByClass(simA, 'pv.inverter')).toBe(4);
    expect(countByClass(simA, 'pv.mppt')).toBe(8);
    expect(sumNameplate(simA, 'pv.inverter', 'dc_kwp')).toBe(1_000);
    expect(countByClass(simA, 'ess.pcs')).toBe(1);
    expect(countByClass(simA, 'ess.rack')).toBe(4);
    expect(sumNameplate(simA, 'ess.rack', 'energy_kwh')).toBe(2_000);
    expect(countByClass(simA, 'wx.station')).toBe(1);
    expect(countByClass(simA, 'grid.meter')).toBe(1);
    expect(countByClass(simA, 'h2.elz')).toBe(0);
  });

  it('SIM-B: PV 2 MWp + ESS 1 MWh + 전해조·압축기·저장뱅크(용기 4)·검지기 4·연료전지 + 기상 + 계량기', () => {
    const simB = site('SIM-B');

    expect(countByClass(simB, 'pv.inverter')).toBe(4);
    expect(sumNameplate(simB, 'pv.inverter', 'dc_kwp')).toBe(2_000);
    expect(countByClass(simB, 'ess.rack')).toBe(2);
    expect(sumNameplate(simB, 'ess.rack', 'energy_kwh')).toBe(1_000);
    for (const classKey of ['h2.elz', 'h2.elz.stack', 'h2.elz.rectifier', 'h2.elz.water', 'h2.elz.gls', 'h2.elz.dryer', 'h2.compressor', 'h2.storage.bank', 'fc.plant', 'fc.stack', 'fc.blower', 'fc.cooling', 'wx.station', 'grid.meter']) {
      expect(countByClass(simB, classKey), classKey).toBe(1);
    }
    expect(countByClass(simB, 'h2.storage.tank')).toBe(4);
    expect(countByClass(simB, 'h2.detector')).toBe(4);
    expect(simB.assets.find((a) => a.classKey === 'h2.elz')?.nameplate.rated_kw).toBe(500);
    expect(simB.assets.find((a) => a.classKey === 'fc.plant')?.nameplate.rated_kw).toBe(200);
  });

  it('SIM-C는 SIM-B와 같은 설비·포인트 구성이고 대조군 표시가 있다', () => {
    const withoutPeer = (s: SiteDef) => s.assets.map((asset) => ({ ...asset, peerGroup: null }));

    expect(withoutPeer(site('SIM-C'))).toEqual(withoutPeer(site('SIM-B')));
    expect(site('SIM-C').attributes.control_group).toBe(true);
  });
});

describe.each(SIM_SITES.map((s) => [s.code, s] as const))('%s 무결성', (_code, s) => {
  it('설비 코드가 유일하고 부모가 자식보다 먼저 정의된다', () => {
    const seen = new Set<string>();
    for (const asset of s.assets) {
      expect(seen.has(asset.code), asset.code).toBe(false);
      const parent = parentCode(asset);
      if (parent) expect(seen.has(parent), `${asset.code}의 부모 ${parent}`).toBe(true);
      seen.add(asset.code);
    }
  });

  it('설비 level은 설비 종류와 같고 명판은 스키마의 필수 필드·타입을 만족한다', () => {
    for (const asset of s.assets) {
      const assetClass = ASSET_CLASS_BY_KEY.get(asset.classKey);
      expect(assetClass, asset.code).toBeDefined();
      expect(asset.level, asset.code).toBe(assetClass?.level);

      const schema = assetClass?.nameplateSchema;
      for (const field of schema?.required ?? []) expect(asset.nameplate, asset.code).toHaveProperty(field);
      for (const [field, value] of Object.entries(asset.nameplate)) {
        const type = schema?.properties[field]?.type;
        expect(type, `${asset.code}.${field}`).toBeDefined();
        if (type === 'string') expect(typeof value).toBe('string');
        if (type === 'number') expect(typeof value).toBe('number');
        if (type === 'integer') expect(Number.isInteger(value), `${asset.code}.${field}`).toBe(true);
      }
    }
  });

  it('포인트: 메트릭이 카탈로그에 있고 source_key·(설비, 메트릭, 한정자)가 유일하다', () => {
    const sourceKeys = new Set<string>();
    for (const asset of s.assets) {
      const assetMetricKeys = new Set<string>();
      for (const point of asset.points) {
        expect(METRIC_DEF_BY_KEY.has(point.metricKey), point.sourceKey).toBe(true);
        expect(point.sourceKey.startsWith(`${asset.code}/`), point.sourceKey).toBe(true);
        expect(sourceKeys.has(point.sourceKey), point.sourceKey).toBe(false);
        sourceKeys.add(point.sourceKey);

        const assetMetricKey = `${point.metricKey}|${point.qualifier}`;
        expect(assetMetricKeys.has(assetMetricKey), `${asset.code} ${assetMetricKey}`).toBe(false);
        assetMetricKeys.add(assetMetricKey);
      }
    }
  });

  it('주기: ESS 랙 I/V/SOC·셀 통계, 스택 V/I, 인버터 AC/DC 전력은 60초, 나머지는 300초', () => {
    for (const asset of s.assets) {
      for (const point of asset.points) {
        const expected = FAST_POINTS[asset.classKey]?.includes(point.metricKey) ? 60 : 300;
        expect(point.periodS, point.sourceKey).toBe(expected);
      }
    }
  });

  it('게이트웨이 1개와 개발용 키 이름 규칙', () => {
    const compact = s.code.replace('-', '');

    expect(s.gateway).toEqual({
      code: `GW-${compact}-01`,
      keyId: `gk_${s.code.toLowerCase()}_dev`,
      secretEnvVar: `SIM_GATEWAY_SECRET_GW_${compact}_01`,
    });
  });
});

describe('미매핑 예정 태그', () => {
  it('SIM-B에 건조기 이슬점·압축기 진동 태그를 둔다', () => {
    expect(UNMAPPED_SOURCE_TAGS['SIM-B']?.map((tag) => tag.sourceKey)).toEqual(['ELZ1/DRYER/DEWPOINT', 'COMP1/VIB_RMS']);
    expect(site('SIM-B').unmappedTags).toBe(UNMAPPED_SOURCE_TAGS['SIM-B']);
  });

  it('어떤 포인트와도 겹치지 않고, 나중에 매핑할 설비·메트릭은 실제로 있다', () => {
    for (const s of SIM_SITES) {
      const sourceKeys = new Set(s.assets.flatMap((asset) => asset.points.map((point) => point.sourceKey)));
      const assetCodes = new Set(s.assets.map((asset) => asset.code));
      for (const tag of s.unmappedTags) {
        expect(sourceKeys.has(tag.sourceKey), tag.sourceKey).toBe(false);
        expect(assetCodes.has(tag.assetCode), tag.assetCode).toBe(true);
        expect(METRIC_DEF_BY_KEY.get(tag.metricKey)?.unit, tag.metricKey).toBe(tag.unit);
      }
    }
  });
});

describe('gatewaySecretEnvVar', () => {
  it('영숫자가 아닌 문자를 밑줄로 바꾼 대문자 이름을 만든다', () => {
    expect(gatewaySecretEnvVar('GW-SIMA-01')).toBe('SIM_GATEWAY_SECRET_GW_SIMA_01');
    expect(gatewaySecretEnvVar('gw.sim-b.02')).toBe('SIM_GATEWAY_SECRET_GW_SIM_B_02');
  });
});
