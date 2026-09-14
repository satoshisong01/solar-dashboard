import { describe, expect, it } from 'vitest';
import { visibleTree, type ExploreAsset, type ExplorePoint } from './explore-filter';

const asset = (id: number, siteCode: string, parentId: number | null, code: string, name: string): ExploreAsset => ({
  id,
  siteCode,
  parentId,
  code,
  name,
  className: '',
});

const point = (id: number, a: ExploreAsset, metricKey: string, metricName: string): ExplorePoint => ({
  id,
  assetId: a.id,
  siteCode: a.siteCode,
  assetCode: a.code,
  metricKey,
  metricName,
  qualifier: '',
  unit: '',
  classKey: '',
});

const pv = asset(1, 'SIM-A', null, 'PV1', '태양광 발전설비');
const inv = asset(2, 'SIM-A', 1, 'PV1/INV01', '인버터 1');
const ess = asset(3, 'SIM-A', null, 'ESS1', 'ESS 설비');
const elz = asset(4, 'SIM-B', null, 'ELZ1', 'PEM 수전해 설비');
const assets = [pv, inv, ess, elz];
const points = [
  point(10, inv, 'ac.power', '교류 유효전력'),
  point(11, ess, 'room.temp', '배터리실 온도'),
  point(12, elz, 'ac.power', '교류 유효전력'),
];

describe('visibleTree', () => {
  it('필터가 없으면 포인트가 있는 가지를 사이트별로 모두 보여 준다', () => {
    const tree = visibleTree(assets, points, { metricKey: '', text: '' });
    expect(tree.map((site) => [site.siteCode, site.pointCount])).toEqual([
      ['SIM-A', 2],
      ['SIM-B', 1],
    ]);
    // 포인트가 없는 PV1은 하위 인버터 때문에 남는다
    expect(tree[0].nodes.map((node) => node.asset.code)).toEqual(['ESS1', 'PV1']);
    expect(tree[0].nodes[1].children[0].points.map((p) => p.id)).toEqual([10]);
  });

  it('메트릭 필터에 맞는 포인트가 없는 가지와 사이트는 뺀다', () => {
    const tree = visibleTree(assets, points, { metricKey: 'room.temp', text: '' });
    expect(tree).toHaveLength(1);
    expect(tree[0].nodes.map((node) => node.asset.code)).toEqual(['ESS1']);
  });

  it('검색어는 메트릭 이름과 설비 코드·이름에 부분 일치(대소문자 무시)', () => {
    expect(visibleTree(assets, points, { metricKey: '', text: 'inv01' }).flatMap((s) => s.pointCount)).toEqual([1]);
    expect(visibleTree(assets, points, { metricKey: 'ac.power', text: '수전해' }).map((s) => s.siteCode)).toEqual(['SIM-B']);
    expect(visibleTree(assets, points, { metricKey: '', text: '없는말' })).toEqual([]);
  });

  it('반환 노드에는 트리 children 대신 보이는 자식만 담긴다', () => {
    const [site] = visibleTree(assets, points, { metricKey: 'room.temp', text: '' });
    expect(site.nodes[0]).toEqual({ asset: ess, points: [points[1]], children: [] });
  });
});
