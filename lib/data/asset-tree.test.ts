import { describe, expect, it } from 'vitest';
import { buildAssetTree, countNodes } from './asset-tree';

const asset = (id: number, parentId: number | null, code: string) => ({ id, parentId, code });

describe('buildAssetTree', () => {
  it('system → asset → component 계층을 만들고 형제는 code 순으로 정렬한다', () => {
    const tree = buildAssetTree([
      asset(3, 1, 'PV1/INV02'),
      asset(1, null, 'PV1'),
      asset(4, 2, 'PV1/INV01/MPPT1'),
      asset(2, 1, 'PV1/INV01'),
      asset(5, null, 'COMP1'),
    ]);

    expect(tree.map((node) => node.code)).toEqual(['COMP1', 'PV1']);
    expect(tree[1].children.map((node) => node.code)).toEqual(['PV1/INV01', 'PV1/INV02']);
    expect(tree[1].children[0].children.map((node) => node.code)).toEqual(['PV1/INV01/MPPT1']);
    expect(countNodes(tree)).toBe(5);
  });

  it('부모가 목록에 없으면 루트로 둔다', () => {
    const tree = buildAssetTree([asset(7, 99, 'ESS1/RACK01')]);
    expect(tree).toEqual([{ id: 7, parentId: 99, code: 'ESS1/RACK01', children: [] }]);
  });

  it('입력 객체를 바꾸지 않고 추가 필드를 유지한다', () => {
    const input = [Object.freeze({ id: 1, parentId: null, code: 'FC1', name: '연료전지' })];
    const [root] = buildAssetTree(input);
    expect(root).toEqual({ id: 1, parentId: null, code: 'FC1', name: '연료전지', children: [] });
    expect(input[0]).not.toHaveProperty('children');
  });

  it('자기 자신이나 순환을 가리켜도 끝나고 각 설비는 한 번만 들어간다', () => {
    expect(countNodes(buildAssetTree([asset(1, 1, 'A')]))).toBe(1);
    // 1 ↔ 2 순환: 루트가 없으므로 둘 다 트리에 오르지 않는다 (DB FK 트리에서는 생기지 않는 경우)
    expect(buildAssetTree([asset(1, 2, 'A'), asset(2, 1, 'B')])).toEqual([]);
  });

  it('빈 목록이면 빈 트리', () => {
    expect(buildAssetTree([])).toEqual([]);
  });
});
