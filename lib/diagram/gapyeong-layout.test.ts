import { describe, expect, it } from 'vitest';
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { pipeNodeIds, parseSource } from './diagram-view';
import {
  DIAGRAM_METRIC_KEYS,
  DIAGRAM_VIEWBOX,
  NODES,
  PIPES,
  TAGS,
  TAG_RADIUS,
  type NodeDef,
  type Vertex,
} from './gapyeong-layout';

interface Rect {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

const boxOf = (node: NodeDef): Rect => ({ id: node.id, x1: node.x, y1: node.y, x2: node.x + node.w, y2: node.y + node.h });
const bubbleOf = (cx: number, cy: number, id: string): Rect => ({ id, x1: cx - TAG_RADIUS, y1: cy - TAG_RADIUS, x2: cx + TAG_RADIUS, y2: cy + TAG_RADIUS });
const overlaps = (a: Rect, b: Rect): boolean => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/** 점이 상자 테두리 위에 있는가 (배관이 상자에 붙는지 확인) */
function onBoundary([x, y]: Vertex, box: Rect): boolean {
  const insideX = x >= box.x1 - 1 && x <= box.x2 + 1;
  const insideY = y >= box.y1 - 1 && y <= box.y2 + 1;
  const onVerticalEdge = (Math.abs(x - box.x1) <= 1 || Math.abs(x - box.x2) <= 1) && insideY;
  const onHorizontalEdge = (Math.abs(y - box.y1) <= 1 || Math.abs(y - box.y2) <= 1) && insideX;
  return onVerticalEdge || onHorizontalEdge;
}

describe('가평 공정도 배치', () => {
  const boxes = NODES.map(boxOf);

  it('상자 id가 겹치지 않고 모두 도면 안에 있다', () => {
    expect(new Set(NODES.map((node) => node.id)).size).toBe(NODES.length);
    for (const box of boxes) {
      expect(box.x1, box.id).toBeGreaterThanOrEqual(0);
      expect(box.y1, box.id).toBeGreaterThanOrEqual(0);
      expect(box.x2, box.id).toBeLessThanOrEqual(DIAGRAM_VIEWBOX.width);
      expect(box.y2, box.id).toBeLessThanOrEqual(DIAGRAM_VIEWBOX.height);
    }
  });

  it('설비 상자끼리 겹치지 않는다', () => {
    const hits = boxes.flatMap((a, index) => boxes.slice(index + 1).filter((b) => overlaps(a, b)).map((b) => `${a.id}↔${b.id}`));
    expect(hits).toEqual([]);
  });

  it('계장 버블이 설비 상자와도 다른 버블과도 겹치지 않는다', () => {
    const bubbles = TAGS.map((tag) => bubbleOf(tag.cx, tag.cy, tag.tag));
    const onBoxes = bubbles.flatMap((bubble) => boxes.filter((box) => overlaps(bubble, box)).map((box) => `${bubble.id}↔${box.id}`));
    const onBubbles = bubbles.flatMap((a, index) => bubbles.slice(index + 1).filter((b) => overlaps(a, b)).map((b) => `${a.id}↔${b.id}`));
    expect([...onBoxes, ...onBubbles]).toEqual([]);
  });

  it('계장 버블 연결선은 버블 테두리에서 시작한다', () => {
    for (const tag of TAGS) {
      const [x1, y1] = tag.stub;
      const distance = Math.hypot(x1 - tag.cx, y1 - tag.cy);
      expect(Math.round(distance), tag.tag).toBe(TAG_RADIUS);
    }
  });

  it('흐름선 양 끝이 이어 주는 설비 상자의 테두리에 붙는다', () => {
    const boxById = new Map(boxes.map((box) => [box.id, box]));
    const problems: string[] = [];
    for (const pipe of PIPES) {
      const ids = pipeNodeIds(pipe);
      expect(ids.length, pipe.id).toBeGreaterThanOrEqual(1);
      expect(ids.length, pipe.id).toBeLessThanOrEqual(2);
      // 선 id는 `from.to`다: 첫 점은 from 상자, 마지막 점은 to 상자 테두리에 붙어야 한다
      const [from, to] = pipe.id.split('.') as [string, string];
      const check = (nodeId: string, end: Vertex) => {
        const box = boxById.get(nodeId);
        if (box && !onBoundary(end, box)) problems.push(`${pipe.id}: ${nodeId}에 붙지 않는다 (${end.join(',')})`);
      };
      check(from, pipe.points[0] as Vertex);
      check(to, pipe.points[pipe.points.length - 1] as Vertex);
      // 꺾은선은 가로·세로로만 꺾인다 (도면과 같은 직교 배관)
      for (let i = 1; i < pipe.points.length; i += 1) {
        const [px, py] = pipe.points[i - 1] as Vertex;
        const [qx, qy] = pipe.points[i] as Vertex;
        if (px !== qx && py !== qy) problems.push(`${pipe.id}: 비스듬한 구간`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('계장 태그는 도면에 그려진 10점이고 모두 상자에 걸린다', () => {
    const ids = new Set(NODES.map((node) => node.id));
    expect(TAGS.map((tag) => tag.tag)).toEqual(['LT-101', 'FT-101', 'TT-303', 'TT-302', 'TT-301', 'PT-401', 'PT-201', 'FT-201', 'PT-202', 'FT-301']);
    for (const tag of TAGS) expect(ids.has(tag.nodeId), tag.tag).toBe(true);
  });
});

describe('카탈로그와의 정합', () => {
  it('상자의 설비 종류가 카탈로그에 있다', () => {
    for (const node of NODES) expect(ASSET_CLASS_BY_KEY.has(node.classKey), node.id).toBe(true);
  });

  it('상자에 적는 명판 항목이 그 설비 종류 스키마에 있고 단위가 제목과 같다', () => {
    for (const node of NODES) {
      const schema = ASSET_CLASS_BY_KEY.get(node.classKey)?.nameplateSchema as { properties?: Record<string, { title?: string }> } | undefined;
      for (const cap of node.capacity) {
        const title = schema?.properties?.[cap.key]?.title;
        expect(title, `${node.id}/${cap.key}`).toBeTypeOf('string');
        expect(title, `${node.id}/${cap.key}`).toContain(`(${cap.unit})`);
      }
    }
  });

  it('읽는 메트릭이 모두 카탈로그에 있고 gauge다 (누적 카운터를 그대로 보여 주지 않는다)', () => {
    const sources = [...NODES.flatMap((node) => node.readouts.flatMap((readout) => readout.sources)), ...TAGS.flatMap((tag) => tag.sources)];
    for (const source of sources) {
      const { metricKey } = parseSource(source);
      const metric = METRIC_DEF_BY_KEY.get(metricKey);
      expect(metric, source).toBeDefined();
      expect(metric?.valueKind, source).toBe('gauge');
    }
    expect(DIAGRAM_METRIC_KEYS.length).toBeGreaterThan(0);
    expect([...DIAGRAM_METRIC_KEYS]).toEqual([...DIAGRAM_METRIC_KEYS].sort());
  });
});
