import { describe, expect, it } from 'vitest';
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from './catalog';
import { gatewaySecretEnvVar, SEED_SITES, SIM_SITES, simulatorSites, UNMAPPED_SOURCE_TAGS } from './sites';
import type { AssetDef, SiteDef } from './types';

function site(code: string): SiteDef {
  const found = SEED_SITES.find((candidate) => candidate.code === code);
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

describe('SEED_SITES 구성', () => {
  it('가상 3곳과 실사이트 1곳을 좌표와 함께 정의한다', () => {
    expect(SEED_SITES.map((s) => [s.code, s.name, s.lat, s.lon])).toEqual([
      ['SIM-A', '영암 태양광·ESS', 34.8, 126.7],
      ['SIM-B', '새만금 연계형', 35.85, 126.55],
      ['SIM-C', '제주 연계형(대조군)', 33.36, 126.53],
      ['GP-1', '가평 2MW 청정수소발전', 37.83, 127.51],
    ]);
  });

  it('시뮬레이터 대상은 simulated 사이트뿐이고, 실사이트는 설정으로만 연다', () => {
    expect(SIM_SITES.map((s) => s.code)).toEqual(['SIM-A', 'SIM-B', 'SIM-C']);
    expect(simulatorSites().map((s) => s.code)).toEqual(['SIM-A', 'SIM-B', 'SIM-C']);
    expect(simulatorSites({ includeRealSites: true }).map((s) => s.code)).toEqual(['SIM-A', 'SIM-B', 'SIM-C', 'GP-1']);
    expect(site('GP-1').attributes.simulated).toBe(false);
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

describe.each(SEED_SITES.map((s) => [s.code, s] as const))('%s 무결성', (_code, s) => {
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
        if (value === null) continue; // 미확인 명판 (추정값으로 채우지 않는다)
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

  // 가상 사이트는 시뮬레이터 스텝(60초)에 맞춘 규약을 쓰고, 실사이트는 데이터 계약이 정한 주기를 쓴다
  it('주기: 가상 사이트는 ESS 랙 I/V/SOC·셀 통계, 스택 V/I, 인버터 AC/DC 전력만 60초이고 나머지는 300초', () => {
    if (s.attributes.simulated !== true) {
      expect(s.assets.flatMap((asset) => asset.points).filter((point) => !Number.isSafeInteger(point.periodS) || point.periodS <= 0)).toEqual([]);
      return;
    }
    for (const asset of s.assets) {
      for (const point of asset.points) {
        const expected = FAST_POINTS[asset.classKey]?.includes(point.metricKey) ? 60 : 300;
        expect(point.periodS, point.sourceKey).toBe(expected);
      }
    }
  });

  it('도면 계장 태그는 실사이트에만 있고 사이트 안에서 유일하다', () => {
    const tags = s.assets.flatMap((asset) => asset.points.flatMap((point) => (point.instrumentTag === null ? [] : [point.instrumentTag])));

    expect(new Set(tags).size, s.code).toBe(tags.length);
    if (s.attributes.simulated === true) expect(tags, s.code).toEqual([]);
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

describe('GP-1 가평 실사이트', () => {
  const gp = site('GP-1');
  const assetByCode = new Map(gp.assets.map((asset) => [asset.code, asset]));

  it('도면의 설비 트리를 명판 그대로 담는다 (미확인 값은 null)', () => {
    expect(gp.assets.map((asset) => asset.code)).toEqual([
      'PV1', 'ESS1', 'ELZ1', 'ELZ1/RECT1', 'ELZ1/WTU1', 'ELZ1/WTU1/TANK1', 'H2BUF1', 'H2BUF1/TANK1', 'PRV1',
      'FC1', 'FC1/HX1', 'FC1/PCS1', 'MTR1', 'O2P1', 'O2P1/TANK1', 'O2P1/LOAD1', 'H2DLV1',
    ]);
    expect(assetByCode.get('PV1')?.nameplate).toMatchObject({ dc_kwp: 1_500 });
    expect(assetByCode.get('ESS1')?.nameplate).toMatchObject({ energy_kwh: 2_000, chemistry: null });
    expect(assetByCode.get('ELZ1')?.nameplate).toMatchObject({ rated_kw: 2_500, h2_rated_kg_h: 44.9, outlet_bar: 30, nm3_reference_c: null });
    expect(assetByCode.get('ELZ1/WTU1/TANK1')?.nameplate).toMatchObject({ volume_m3: 20 });
    expect(assetByCode.get('H2BUF1')?.nameplate).toMatchObject({ water_volume_l: 50_000, max_bar: 30, pressure_basis: null });
    expect(assetByCode.get('PRV1')?.nameplate).toMatchObject({ inlet_bar_max: 30, outlet_bar_set: 0.8 });
    expect(assetByCode.get('FC1')?.nameplate).toMatchObject({ rated_kw: 2_000, technology: 'PEMFC' });
    expect(assetByCode.get('FC1/HX1')?.nameplate).toMatchObject({ duty_kw: 350 });
    expect(assetByCode.get('FC1/PCS1')?.nameplate).toMatchObject({ power_kw: 2_500 });
    expect(assetByCode.get('MTR1')?.nameplate).toMatchObject({ voltage_v: 22_900 });
    expect(assetByCode.get('O2P1/TANK1')?.nameplate).toMatchObject({ water_volume_m3: 30, max_bar: 15, pressure_basis: null });
    // 도면에 승압 압축기가 없다 — 생산 산소를 트레일러에 담을 수 없다는 사실을 명판에 남긴다
    expect(assetByCode.get('O2P1/LOAD1')?.nameplate).toMatchObject({ compressor_present: 'none' });
    // 준공 전이라 기준선 시작일이 없다
    expect(gp.assets.every((asset) => asset.commissionedAt === null)).toBe(true);
  });

  it('도면 계장 태그 10점을 포인트로 매핑한다', () => {
    const points = gp.assets.flatMap((asset) => asset.points.map((point) => [point.instrumentTag, `${asset.code}/${point.metricKey}${point.qualifier === '' ? '' : `@${point.qualifier}`}`, point.periodS]));

    expect(points.sort()).toEqual([
      ['FT-101', 'ELZ1/WTU1/water.flow.feed', 60],
      ['FT-201', 'ELZ1/h2.flow.mass@elz.out', 60],
      ['FT-301', 'FC1/fc.h2.consumption', 60],
      ['LT-101', 'ELZ1/WTU1/TANK1/water.tank.level', 60],
      ['PT-201', 'H2BUF1/h2.pressure@buffer', 60],
      ['PT-202', 'FC1/h2.pressure@fc.inlet', 60],
      ['PT-401', 'O2P1/TANK1/tank.pressure@o2', 10],
      ['TT-301', 'FC1/HX1/hx.temp.hot.in', 10],
      ['TT-302', 'FC1/HX1/hx.temp.hot.out', 10],
      ['TT-303', 'FC1/HX1/hx.temp.cold.out', 10],
    ]);
  });

  it('신설 요청 포인트(미설치)는 카탈로그·설비를 가리키고 이미 있는 포인트와 겹치지 않는다', () => {
    const mapped = new Set(gp.assets.flatMap((asset) => asset.points.map((point) => `${asset.code}|${point.metricKey}|${point.qualifier}`)));
    const seen = new Set<string>();

    for (const planned of gp.plannedPoints) {
      const key = `${planned.assetCode}|${planned.metricKey}|${planned.qualifier}`;
      expect(assetByCode.has(planned.assetCode), planned.assetCode).toBe(true);
      expect(METRIC_DEF_BY_KEY.has(planned.metricKey), planned.metricKey).toBe(true);
      expect(mapped.has(key), key).toBe(false); // 이미 계기가 있으면 '신설 요청'이 아니다
      expect(seen.has(key), key).toBe(false);
      expect(planned.periodS, key).toBeGreaterThan(0);
      seen.add(key);
    }
    // 부록 B 40점 중 PT-202 스팬 재지정(기존 계기 사양 변경)을 미설치에서 뺀 39점.
    // 한 계기가 여러 신호를 내면(적산열량계·질량유량계) 여러 줄이 된다.
    expect(gp.plannedPoints.filter((planned) => planned.necessity === 'required').length).toBe(36);
    expect(gp.plannedPoints.filter((planned) => planned.necessity === 'recommended').length).toBe(15);
  });

  it('가상 사이트에는 신설 요청 포인트가 없다', () => {
    expect(SIM_SITES.flatMap((s) => s.plannedPoints)).toEqual([]);
  });
});

describe('미매핑 예정 태그', () => {
  it('SIM-B에 건조기 이슬점·압축기 진동 태그를 둔다', () => {
    expect(UNMAPPED_SOURCE_TAGS['SIM-B']?.map((tag) => tag.sourceKey)).toEqual(['ELZ1/DRYER/DEWPOINT', 'COMP1/VIB_RMS']);
    expect(site('SIM-B').unmappedTags).toBe(UNMAPPED_SOURCE_TAGS['SIM-B']);
  });

  it('어떤 포인트와도 겹치지 않고, 나중에 매핑할 설비·메트릭은 실제로 있다', () => {
    for (const s of SEED_SITES) {
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
