import { describe, expect, it } from 'vitest';
import { QUALITY } from '@/lib/ingest/quality';
import {
  buildDiagram,
  digitsForUnit,
  parseSource,
  readCapacity,
  readValue,
  type DiagramAssetInput,
  type DiagramFindingInput,
  type DiagramInput,
  type DiagramPointInput,
} from './diagram-view';

const NOW = Date.parse('2026-09-17T12:00:00+09:00');

let nextId = 1;
const asset = (code: string, classKey: string, nameplate: Record<string, unknown> = {}): DiagramAssetInput => ({
  id: nextId++,
  code,
  name: `${code} 설비`,
  classKey,
  className: classKey,
  nameplate,
});

const point = (
  assetCode: string,
  metricKey: string,
  value: number | null,
  extra: Partial<DiagramPointInput> = {},
): DiagramPointInput => ({
  id: nextId++,
  assetCode,
  metricKey,
  qualifier: '',
  unit: 'bar',
  valueKind: 'gauge',
  periodS: 60,
  instrumentTag: null,
  tsMs: NOW - 30_000,
  value,
  quality: 0,
  ...extra,
});

const finding = (assetCode: string | null, severity: number, extra: Partial<DiagramFindingInput> = {}): DiagramFindingInput => ({
  id: String(nextId++),
  assetCode,
  severity,
  category: 'degradation',
  title: '발견사항',
  ...extra,
});

const input = (partial: Partial<DiagramInput> = {}): DiagramInput => ({
  siteCode: 'GP-1',
  assets: [],
  points: [],
  findings: [],
  nowMs: NOW,
  ...partial,
});

const nodeOf = (view: ReturnType<typeof buildDiagram>, id: string) => {
  const found = view.nodes.find((node) => node.def.id === id);
  if (!found) throw new Error(`상자 없음: ${id}`);
  return found;
};

describe('parseSource', () => {
  it('한정자가 없으면 null', () => {
    expect(parseSource('h2.pressure')).toEqual({ metricKey: 'h2.pressure', qualifier: null });
    expect(parseSource('h2.pressure@buffer')).toEqual({ metricKey: 'h2.pressure', qualifier: 'buffer' });
  });
});

describe('값 포맷', () => {
  it('단위마다 소수 자릿수가 다르다', () => {
    expect(digitsForUnit('bar')).toBe(2);
    expect(digitsForUnit('kW')).toBe(0);
    expect(digitsForUnit('µS/cm')).toBe(3);
    expect(digitsForUnit('알 수 없는 단위')).toBe(1);
  });

  it('값과 단위를 함께 적는다', () => {
    const value = readValue('압력', [point('H2BUF1', 'h2.pressure', 28.4321)], 'first', NOW);
    expect(value.text).toBe('28.43 bar');
    expect(value.state).toBe('ok');
  });

  it('포인트가 없으면 포인트 없음, 값이 없으면 데이터 없음', () => {
    expect(readValue('압력', [], 'first', NOW)).toMatchObject({ state: 'unmapped', text: '포인트 없음', value: null });
    expect(readValue('압력', [point('A', 'h2.pressure', null, { tsMs: null })], 'first', NOW)).toMatchObject({ state: 'missing', text: '데이터 없음' });
  });

  it('수집 주기의 3배를 넘으면 지연, 10배를 넘으면 데이터 없음 (틀린 값을 그대로 보여주지 않는다)', () => {
    const late = readValue('압력', [point('A', 'h2.pressure', 1, { tsMs: NOW - 200_000 })], 'first', NOW);
    expect(late.state).toBe('late');
    expect(late.text).toBe('1 bar'); // formatNumber는 뒤따르는 0을 붙이지 않는다
    const gone = readValue('압력', [point('A', 'h2.pressure', 1, { tsMs: NOW - 700_000 })], 'first', NOW);
    expect(gone).toMatchObject({ state: 'missing', text: '데이터 없음', value: null });
  });

  it('품질 이상 비트가 켜지면 값 대신 품질 이상', () => {
    const bad = readValue('압력', [point('A', 'h2.pressure', 9999, { quality: QUALITY.HARD_RANGE })], 'first', NOW);
    expect(bad).toMatchObject({ state: 'invalid', text: '품질 이상', value: null });
  });

  it('합·평균은 포인트 여럿을 모은다', () => {
    const points = [point('PV1/INV01', 'ac.power', 100, { unit: 'kW' }), point('PV1/INV02', 'ac.power', 50, { unit: 'kW' })];
    expect(readValue('합', points, 'sum', NOW).text).toBe('150 kW');
    expect(readValue('평균', points, 'avg', NOW).text).toBe('75 kW');
    expect(readValue('첫', points, 'first', NOW).text).toBe('100 kW');
  });
});

describe('명판 용량', () => {
  it('미확인(null) 명판은 숫자를 지어내지 않고 빠진다', () => {
    expect(readCapacity({ rated_kw: 2500 }, 'rated_kw', 'kW')).toBe('2,500 kW');
    // 명판은 반올림하지 않는다 (도면 값 그대로)
    expect(readCapacity({ h2_rated_kg_h: 44.9 }, 'h2_rated_kg_h', 'kg/h')).toBe('44.9 kg/h');
    expect(readCapacity({ outlet_bar_set: 0.8 }, 'outlet_bar_set', 'bar')).toBe('0.8 bar');
    expect(readCapacity({ rated_kw: null }, 'rated_kw', 'kW')).toBeNull();
    expect(readCapacity({}, 'rated_kw', 'kW')).toBeNull();
  });
});

describe('buildDiagram', () => {
  it('수전해 설비가 없으면 공정도를 그리지 않는다', () => {
    expect(buildDiagram(input({ assets: [asset('PV1', 'pv.plant')] })).available).toBe(false);
    expect(buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz')] })).available).toBe(true);
  });

  it('사이트에 없는 설비 종류는 해당 없음이고, 그 상자에 붙는 흐름선·계장 버블도 그리지 않는다', () => {
    const view = buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz'), asset('H2BANK1', 'h2.storage.bank')] }));
    expect(nodeOf(view, 'o2tank').level).toBe('absent');
    expect(nodeOf(view, 'o2tank').href).toBeNull();
    expect(view.pipes.map((pipe) => pipe.id)).toContain('elz.buffer');
    expect(view.pipes.map((pipe) => pipe.id)).not.toContain('elz.o2p');
    expect(view.tags.map((tag) => tag.def.tag)).toContain('PT-201');
    expect(view.tags.map((tag) => tag.def.tag)).not.toContain('PT-401');
  });

  it('하위 설비는 가장 깊은 상자에 속한다 (FC1/HX1은 연료전지가 아니라 열교환기 상자)', () => {
    const view = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('FC1', 'fc.plant'), asset('FC1/HX1', 'hx.recovery')],
        points: [point('FC1/HX1', 'hx.temp.hot.in', 74.1, { unit: '°C' }), point('FC1', 'fc.ac.power', 1800, { unit: 'kW' })],
      }),
    );
    expect(nodeOf(view, 'hx').readouts[0]?.text).toBe('74.1 °C');
    expect(nodeOf(view, 'fc').readouts[0]?.text).toBe('1,800 kW');
    expect(nodeOf(view, 'fc').pointCount).toBe(1);
  });

  it('계장 태그가 기록돼 있으면 태그로 잇고, 없으면 같은 자리 포인트로 잇는다', () => {
    const tagged = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('H2BUF1', 'h2.storage.bank')],
        points: [point('H2BUF1', 'h2.pressure', 28.4, { qualifier: 'buffer', instrumentTag: 'PT-201' })],
      }),
    );
    const byTag = tagged.tags.find((tag) => tag.def.tag === 'PT-201');
    expect(byTag?.binding).toBe('tag');
    expect(byTag?.value.text).toBe('28.4 bar');
    expect(byTag?.pointLabel).toBe('H2BUF1 / h2.pressure@buffer');

    const untagged = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('H2BANK1', 'h2.storage.bank'), asset('H2BANK1/TANK1', 'h2.storage.tank')],
        points: [point('H2BANK1/TANK1', 'tank.pressure', 30.2)],
      }),
    );
    const byMetric = untagged.tags.find((tag) => tag.def.tag === 'PT-201');
    expect(byMetric?.binding).toBe('metric');
    expect(byMetric?.value.text).toBe('30.2 bar');

    const none = buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz'), asset('H2BUF1', 'h2.storage.bank')] }));
    expect(none.tags.find((tag) => tag.def.tag === 'PT-201')).toMatchObject({ binding: 'none', pointLabel: null });
  });

  it('다른 설비에 붙은 계장 태그도 태그가 맞으면 잇는다 (PT-202는 시드가 연료전지에 매핑했다)', () => {
    const view = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('PRV1', 'h2.prv'), asset('FC1', 'fc.plant')],
        points: [point('FC1', 'h2.pressure', 0.81, { qualifier: 'fc.inlet', instrumentTag: 'PT-202' })],
      }),
    );
    expect(view.tags.find((tag) => tag.def.tag === 'PT-202')).toMatchObject({ binding: 'tag', value: { text: '0.81 bar' } });
  });

  it('열린 발견사항이 상자 강조와 이동 링크를 정한다', () => {
    const view = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('H2BANK1', 'h2.storage.bank'), asset('H2BANK1/TANK2', 'h2.storage.tank'), asset('FC1', 'fc.plant')],
        points: [point('H2BANK1/TANK2', 'tank.pressure', 30)],
        findings: [finding('H2BANK1/TANK2', 4, { id: '900', category: 'safety', title: '저장용기 정지 보유 누설' }), finding('FC1', 2, { id: '901' })],
      }),
    );
    const buffer = nodeOf(view, 'buffer');
    expect(buffer.level).toBe('critical');
    expect(buffer.hasSafetyFinding).toBe(true);
    expect(buffer.openFindingCount).toBe(1);
    expect(buffer.href).toBe('/desk/900');

    const fc = nodeOf(view, 'fc');
    expect(fc.level).toBe('warning');
    expect(fc.href).toBe('/desk/901');

    // 발견사항이 없으면 설비 상세로 간다
    expect(nodeOf(view, 'elz').href).toMatch(/^\/sites\/GP-1\/assets\/\d+$/);
  });

  it('수신이 끊기면 수신 없음, 최근 수신이 있으면 정상', () => {
    const stale = buildDiagram(
      input({ assets: [asset('ELZ1', 'h2.elz')], points: [point('ELZ1', 'h2.pressure', 30, { tsMs: NOW - 2 * 3_600_000 })] }),
    );
    expect(nodeOf(stale, 'elz').level).toBe('offline');
    const fresh = buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz')], points: [point('ELZ1', 'h2.pressure', 30)] }));
    expect(nodeOf(fresh, 'elz').level).toBe('normal');
    // 포인트가 하나도 없는 실사이트도 수신 없음이다 (없는 값을 지어내지 않는다)
    expect(nodeOf(buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz')] })), 'elz').level).toBe('offline');
  });

  it('공정도 상자에 걸리지 않는 발견사항을 따로 모은다 (조용히 숨기지 않는다)', () => {
    const view = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz')],
        findings: [finding(null, 3, { id: '910', title: '수소 물질수지 잔차' }), finding('COMP1', 2, { id: '911' }), finding('ELZ1', 1, { id: '912' })],
      }),
    );
    expect(view.offDiagramFindings.map((item) => item.id)).toEqual(['910', '911']);
    expect(nodeOf(view, 'elz').openFindingCount).toBe(1);
  });

  it('값 갱신 시각은 공정도가 읽은 값 중 가장 최근이다', () => {
    const view = buildDiagram(
      input({
        assets: [asset('ELZ1', 'h2.elz'), asset('FC1', 'fc.plant')],
        points: [point('ELZ1', 'h2.pressure', 30, { tsMs: NOW - 120_000 }), point('FC1', 'fc.ac.power', 1800, { unit: 'kW', tsMs: NOW - 10_000 })],
      }),
    );
    expect(view.lastSampleMs).toBe(NOW - 10_000);
    expect(buildDiagram(input({ assets: [asset('ELZ1', 'h2.elz')] })).lastSampleMs).toBeNull();
  });
});
