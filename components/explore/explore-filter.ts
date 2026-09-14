// 탐색기 트리 필터. 순수 함수 (클라이언트 컴포넌트가 쓴다).
import { buildAssetTree, type AssetNode } from '@/lib/data/asset-tree';

export interface ExploreAsset {
  readonly id: number;
  readonly siteCode: string;
  readonly parentId: number | null;
  readonly code: string;
  readonly name: string;
  readonly className: string;
}

export interface ExplorePoint {
  readonly id: number;
  readonly assetId: number;
  readonly siteCode: string;
  readonly assetCode: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly qualifier: string;
  readonly unit: string;
  readonly classKey: string;
}

/** 탐색기 차트·선택 칩 이름: "SIM-A PV1/INV01 · 교류 유효전력" */
export const explorePointLabel = (point: ExplorePoint): string =>
  `${point.siteCode} ${point.assetCode} · ${point.metricName}${point.qualifier ? ` (${point.qualifier})` : ''}`;

export interface ExploreFilter {
  /** 빈 문자열이면 모든 메트릭 */
  readonly metricKey: string;
  /** 설비 코드·이름, 메트릭 키·이름·구분자 부분 일치 (대소문자 무시) */
  readonly text: string;
}

export interface VisibleNode {
  readonly asset: ExploreAsset;
  readonly points: readonly ExplorePoint[];
  readonly children: readonly VisibleNode[];
}

export interface VisibleSite {
  readonly siteCode: string;
  readonly nodes: readonly VisibleNode[];
  readonly pointCount: number;
}

export function matchesFilter(point: ExplorePoint, asset: ExploreAsset | undefined, filter: ExploreFilter): boolean {
  if (filter.metricKey && point.metricKey !== filter.metricKey) return false;
  const text = filter.text.trim().toLowerCase();
  if (!text) return true;
  return [point.metricName, point.metricKey, point.qualifier, asset?.code ?? '', asset?.name ?? ''].some((field) =>
    field.toLowerCase().includes(text),
  );
}

function prune(node: AssetNode<ExploreAsset>, pointsByAsset: ReadonlyMap<number, readonly ExplorePoint[]>): VisibleNode | null {
  const children = node.children.map((child) => prune(child, pointsByAsset)).filter((child): child is VisibleNode => child !== null);
  const points = pointsByAsset.get(node.id) ?? [];
  if (points.length === 0 && children.length === 0) return null;
  const asset: ExploreAsset = {
    id: node.id,
    siteCode: node.siteCode,
    parentId: node.parentId,
    code: node.code,
    name: node.name,
    className: node.className,
  };
  return { asset, points, children };
}

const countPoints = (nodes: readonly VisibleNode[]): number =>
  nodes.reduce((total, node) => total + node.points.length + countPoints(node.children), 0);

/** 사이트별 설비 트리에서 필터에 맞는 포인트가 있는 가지만 남긴다 */
export function visibleTree(assets: readonly ExploreAsset[], points: readonly ExplorePoint[], filter: ExploreFilter): readonly VisibleSite[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const pointsByAsset = new Map<number, ExplorePoint[]>();
  for (const point of points.filter((p) => matchesFilter(p, assetById.get(p.assetId), filter))) {
    pointsByAsset.set(point.assetId, [...(pointsByAsset.get(point.assetId) ?? []), point]);
  }

  const siteCodes = [...new Set(assets.map((asset) => asset.siteCode))];
  return siteCodes.flatMap((siteCode) => {
    const tree = buildAssetTree(assets.filter((asset) => asset.siteCode === siteCode));
    const nodes = tree.map((node) => prune(node, pointsByAsset)).filter((node): node is VisibleNode => node !== null);
    return nodes.length === 0 ? [] : [{ siteCode, nodes, pointCount: countPoints(nodes) }];
  });
}
