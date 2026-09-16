// 공정도 SVG 한 장. 서버 컴포넌트 (상태 없음) — 값은 서버에서 그려 보내고 화면에서 다시 계산하지 않는다.
// 흐름선은 물질만, 상태(발견사항)는 설비 상자 테두리·배지로만 나타낸다 (docs/renewal/pid-gapyeong-plan.md §7.4).
import { FLOW_STYLES, FLOW_KINDS, type FlowKind } from '@/lib/diagram/flow-kinds';
import type { DiagramLevel, DiagramNodeView, DiagramTagView, DiagramView } from '@/lib/diagram/diagram-view';
import { DIAGRAM_LEVEL_LABELS } from '@/lib/diagram/diagram-view';
import { DIAGRAM_VIEWBOX, GRID_BUS, TAG_RADIUS, type PipeDef } from '@/lib/diagram/gapyeong-layout';
import { wrapText } from '@/lib/diagram/text-fit';

const PAD = 9;
const TITLE_SIZE = 11.5;
const TITLE_LINE = 13;
const META_SIZE = 8.6;
const READOUT_SIZE = 9;
const VALUE_SIZE = 10.5;
const READOUT_LINE = 13;

interface BoxStyle {
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly fill: string;
  readonly dash?: string;
}

const BOX_STYLES: Readonly<Record<DiagramLevel, BoxStyle>> = {
  critical: { stroke: 'var(--crit)', strokeWidth: 2.5, fill: 'var(--crit-fill)' },
  warning: { stroke: 'var(--warn)', strokeWidth: 2, fill: 'var(--warn-fill)' },
  normal: { stroke: 'var(--rule-strong)', strokeWidth: 1.2, fill: 'var(--surface)' },
  offline: { stroke: 'var(--rule-strong)', strokeWidth: 1.2, fill: 'var(--sunken)', dash: '5 3' },
  absent: { stroke: 'var(--rule)', strokeWidth: 1, fill: 'var(--ground)', dash: '3 3' },
};

const markerId = (kind: FlowKind) => `pid-arrow-${kind.replace('.', '-')}`;

function Defs() {
  return (
    <defs>
      {FLOW_KINDS.map((kind) => (
        <marker key={kind} id={markerId(kind)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={`var(${FLOW_STYLES[kind].token})`} />
        </marker>
      ))}
    </defs>
  );
}

function Pipe({ pipe }: Readonly<{ pipe: PipeDef }>) {
  const style = FLOW_STYLES[pipe.kind];
  const points = pipe.points.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <g>
      <polyline
        points={points}
        fill="none"
        stroke={`var(${style.token})`}
        strokeWidth={style.width}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={pipe.proposed ? '7 5' : (style.dash ?? undefined)}
        markerEnd={`url(#${markerId(pipe.kind)})`}
        opacity={pipe.proposed ? 0.8 : 1}
      />
      {pipe.label !== undefined && pipe.labelAt !== undefined && (
        <text
          x={pipe.labelAt[0]}
          y={pipe.labelAt[1]}
          textAnchor={pipe.labelAnchor ?? 'start'}
          fontSize={META_SIZE}
          fill="var(--muted)"
        >
          {pipe.label}
        </text>
      )}
    </g>
  );
}

/** 열린 발견사항 배지. 색만으로 구분하지 않게 숫자를 함께 적고, 안전 발견사항은 삼각 표시를 따로 붙인다 */
function FindingBadge({ node }: Readonly<{ node: DiagramNodeView }>) {
  if (node.openFindingCount === 0) return null;
  const crit = node.level === 'critical';
  const cx = node.def.x + node.def.w - 11;
  const cy = node.def.y + 11;
  return (
    <g>
      <circle cx={cx} cy={cy} r={9.5} fill={crit ? 'var(--crit)' : 'var(--warn)'} stroke="var(--surface)" strokeWidth={1.2} />
      <text x={cx} y={cy + 3.4} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={crit ? 'var(--crit-fill)' : 'var(--warn-fill)'}>
        {node.openFindingCount}
      </text>
      {node.hasSafetyFinding && (
        <path d={`M ${cx - 24} ${cy + 5} L ${cx - 16} ${cy - 7} L ${cx - 8} ${cy + 5} z`} fill="var(--crit)" stroke="var(--surface)" strokeWidth={1} />
      )}
    </g>
  );
}

function NodeBox({ node }: Readonly<{ node: DiagramNodeView }>) {
  const { def } = node;
  const style = BOX_STYLES[node.level];
  const inner = def.w - PAD * 2;
  const name = node.asset?.name ?? def.label;
  const titleLines = wrapText(name, inner, TITLE_SIZE, 2);
  let cursor = def.y + PAD + TITLE_SIZE;
  const titleY = titleLines.map((_, index) => cursor + index * TITLE_LINE);
  cursor += (titleLines.length - 1) * TITLE_LINE;

  const meta = node.asset === null ? DIAGRAM_LEVEL_LABELS.absent : node.capacity.join(' · ');
  if (meta !== '') cursor += 11;
  const metaY = cursor;
  if (def.note !== undefined) cursor += 10;
  const noteY = cursor;

  const label = [node.asset ? `${node.asset.code} · ${name}` : `${def.label} (${DIAGRAM_LEVEL_LABELS.absent})`, DIAGRAM_LEVEL_LABELS[node.level]];
  if (node.openFindingCount > 0) label.push(`열린 발견사항 ${node.openFindingCount}건`);

  const body = (
    <g data-node-id={def.id} data-level={node.level}>
      <title>{label.join(' · ')}</title>
      <rect
        x={def.x}
        y={def.y}
        width={def.w}
        height={def.h}
        rx={6}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.dash}
      />
      {titleLines.map((line, index) => (
        <text key={line} x={def.x + PAD} y={titleY[index]} fontSize={TITLE_SIZE} fontWeight={600} fill="var(--ink)">
          {line}
        </text>
      ))}
      {meta !== '' && (
        <text x={def.x + PAD} y={metaY} fontSize={META_SIZE} fill="var(--muted)">
          {meta}
        </text>
      )}
      {def.note !== undefined && (
        <text x={def.x + PAD} y={noteY} fontSize={META_SIZE} fill="var(--muted)" fontStyle="italic">
          {def.note}
        </text>
      )}
      {node.asset !== null &&
        node.readouts.map((readout, index) => {
          const y = noteY + 13 + index * READOUT_LINE;
          const dim = readout.state !== 'ok';
          return (
            <g key={readout.label}>
              <text x={def.x + PAD} y={y} fontSize={READOUT_SIZE} fill="var(--muted)">
                {readout.label}
              </text>
              <text
                x={def.x + def.w - PAD}
                y={y}
                textAnchor="end"
                fontSize={dim ? READOUT_SIZE : VALUE_SIZE}
                fontFamily="var(--font-mono)"
                fill={dim ? 'var(--muted)' : 'var(--ink)'}
              >
                {readout.text}
              </text>
            </g>
          );
        })}
      <FindingBadge node={node} />
    </g>
  );

  if (node.href === null) return body;
  return (
    <a href={node.href} aria-label={label.join(' · ')}>
      {body}
    </a>
  );
}

/** 계장 태그 버블. 도면과 같이 가운데 가로선을 긋고 위에 태그, 아래에 계기 번호를 적는다 */
function TagBubble({ tag }: Readonly<{ tag: DiagramTagView }>) {
  const { def, value } = tag;
  const [prefix, ...rest] = def.tag.split('-');
  const suffix = rest.join('-');
  const dim = value.state !== 'ok';
  const title = [def.tag, tag.pointLabel ?? '연결된 포인트 없음', value.text, tag.binding === 'metric' ? '계장 태그 미기록 — 같은 자리 포인트로 연결' : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <g data-tag={def.tag} data-binding={tag.binding}>
      <title>{title}</title>
      <line x1={def.stub[0]} y1={def.stub[1]} x2={def.stub[2]} y2={def.stub[3]} stroke="var(--rule-strong)" strokeWidth={1} />
      <circle
        cx={def.cx}
        cy={def.cy}
        r={TAG_RADIUS}
        fill="var(--surface)"
        stroke="var(--ink-2)"
        strokeWidth={1.2}
        strokeDasharray={tag.binding === 'none' ? '3 3' : undefined}
      />
      <line x1={def.cx - TAG_RADIUS} y1={def.cy} x2={def.cx + TAG_RADIUS} y2={def.cy} stroke="var(--ink-2)" strokeWidth={1} />
      <text x={def.cx} y={def.cy - 4} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--ink)">
        {prefix}
      </text>
      <text x={def.cx} y={def.cy + 12} textAnchor="middle" fontSize={9} fill="var(--ink-2)">
        {suffix}
      </text>
      <text
        x={def.cx + def.valueDx}
        y={def.cy + def.valueDy}
        textAnchor={def.valueAnchor}
        fontSize={dim ? 9 : 10.5}
        fontFamily="var(--font-mono)"
        fill={dim ? 'var(--muted)' : 'var(--ink)'}
      >
        {value.text}
      </text>
    </g>
  );
}

export function ProcessDiagram({ view, label }: Readonly<{ view: DiagramView; label: string }>) {
  return (
    <svg
      viewBox={`0 0 ${DIAGRAM_VIEWBOX.width} ${DIAGRAM_VIEWBOX.height}`}
      role="img"
      aria-label={label}
      className="h-auto w-full min-w-[66rem]"
      fontFamily="var(--font-sans)"
    >
      <Defs />
      <g>
        {view.pipes.map((pipe) => (
          <Pipe key={pipe.id} pipe={pipe} />
        ))}
      </g>
      <line x1={GRID_BUS.x} y1={GRID_BUS.y1} x2={GRID_BUS.x} y2={GRID_BUS.y2} stroke="var(--ink-2)" strokeWidth={3} />
      <text x={GRID_BUS.labelX} y={GRID_BUS.labelY} textAnchor="end" fontSize={META_SIZE} fill="var(--muted)">
        {GRID_BUS.label}
      </text>
      <g>
        {view.nodes.map((node) => (
          <NodeBox key={node.def.id} node={node} />
        ))}
      </g>
      <g>
        {view.tags.map((tag) => (
          <TagBubble key={tag.def.tag} tag={tag} />
        ))}
      </g>
    </svg>
  );
}
