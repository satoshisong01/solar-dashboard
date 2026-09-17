// 공정도 옆에 붙는 표·범례. SVG를 볼 수 없는 좁은 화면과 화면 낭독기를 위한 대체 뷰이기도 하다.
import Link from 'next/link';
import { CircleMinus } from 'lucide-react';
import { MapLevelBadge } from '@/components/map/map-level';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { FindingSeverityChip } from '@/components/desk/finding-badges';
import { DIAGRAM_LEVEL_LABELS, VALUE_STATE_LABELS, type DiagramLevel, type DiagramView } from '@/lib/diagram/diagram-view';
import { FLOW_KINDS, FLOW_STYLES } from '@/lib/diagram/flow-kinds';
import { formatAgo, formatKstDateTime } from '@/lib/format';

export function DiagramLevelBadge({ level }: Readonly<{ level: DiagramLevel }>) {
  if (level === 'absent') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-sunken px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted">
        <CircleMinus aria-hidden="true" className="size-3.5 shrink-0" />
        {DIAGRAM_LEVEL_LABELS.absent}
      </span>
    );
  }
  return <MapLevelBadge level={level} />;
}

/** 도면 범례. 색과 선 모양 둘 다로 구분된다 */
export function FlowLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2">
      {FLOW_KINDS.map((kind) => {
        const style = FLOW_STYLES[kind];
        return (
          <li key={kind} className="flex items-center gap-2 text-xs text-ink-2">
            <svg aria-hidden="true" width="30" height="10" viewBox="0 0 30 10" className="shrink-0">
              <line
                x1="0"
                y1="5"
                x2="30"
                y2="5"
                stroke={`var(${style.token})`}
                strokeWidth={style.width}
                strokeDasharray={style.dash ?? undefined}
              />
            </svg>
            {style.label}
          </li>
        );
      })}
    </ul>
  );
}

/** 설비 상자 목록 — 좁은 화면에서 공정도를 대신한다 */
export function DiagramAssetTable({ view, nowMs }: Readonly<{ view: DiagramView; nowMs: number }>) {
  return (
    <TableScroll label="공정도 설비 목록 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>설비</th>
            <th scope="col" className={TH_CLASS}>상태</th>
            <th scope="col" className={TH_CLASS}>용량 (명판)</th>
            <th scope="col" className={TH_CLASS}>현재 값</th>
            <th scope="col" className={TH_CLASS}>마지막 수신</th>
            <th scope="col" className={TH_CLASS}>열린 발견사항</th>
          </tr>
        </thead>
        <tbody>
          {view.nodes.map((node) => (
            <tr key={node.def.id}>
              <th scope="row" className={`${TD_CLASS} font-medium text-ink`}>
                {node.asset === null ? (
                  <>
                    {node.def.label}
                    <span className="block text-xs font-normal text-muted">이 사이트에 없는 설비</span>
                  </>
                ) : (
                  <Link href={`/sites/${encodeURIComponent(view.siteCode)}/assets/${node.asset.id}`} className="hover:underline">
                    {node.asset.name}
                    <span className="block font-mono text-xs font-normal text-muted">{node.asset.code}</span>
                  </Link>
                )}
              </th>
              <td className={TD_CLASS}>
                <DiagramLevelBadge level={node.level} />
              </td>
              <td className={`${TD_CLASS} text-ink-2`}>{node.capacity.length === 0 ? '—' : node.capacity.join(' · ')}</td>
              <td className={TD_CLASS}>
                {node.asset === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <dl className="flex flex-col gap-0.5">
                    {node.readouts.map((readout) => (
                      <div key={readout.label} className="flex gap-2">
                        <dt className="text-xs text-muted">{readout.label}</dt>
                        <dd className={`font-mono text-xs tabular-nums ${readout.state === 'ok' ? 'text-ink' : 'text-muted'}`}>{readout.text}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                {node.lastSampleMs === null ? (
                  <span className="text-muted">수신 기록 없음</span>
                ) : (
                  <>
                    {formatAgo(node.lastSampleMs, nowMs)}
                    <span className="block font-mono text-xs text-muted">{formatKstDateTime(node.lastSampleMs)}</span>
                  </>
                )}
              </td>
              <td className={TD_CLASS}>
                {node.openFindingCount === 0 || node.worstFindingId === null ? (
                  <span className="text-muted">없음</span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <FindingSeverityChip severity={node.worstSeverity ?? 1} />
                    <Link href={`/desk/${node.worstFindingId}`} className="text-sm text-accent hover:underline">
                      {node.openFindingCount}건 보기
                    </Link>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 도면 계장 태그 ↔ 포인트 매핑 */
export function DiagramTagTable({ view, nowMs }: Readonly<{ view: DiagramView; nowMs: number }>) {
  return (
    <TableScroll label="공정도 계장 태그 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>계장 태그</th>
            <th scope="col" className={TH_CLASS}>연결된 포인트</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>현재 값</th>
            <th scope="col" className={TH_CLASS}>값 상태</th>
            <th scope="col" className={TH_CLASS}>마지막 수신</th>
            <th scope="col" className={TH_CLASS}>비고</th>
          </tr>
        </thead>
        <tbody>
          {view.tags.map((tag) => (
            <tr key={tag.def.tag}>
              <th scope="row" className={`${TD_CLASS} font-mono font-medium text-ink`}>{tag.def.tag}</th>
              <td className={`${TD_CLASS} font-mono text-xs text-ink-2`}>{tag.pointLabel ?? <span className="font-sans text-muted">연결된 포인트 없음</span>}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} ${tag.value.state === 'ok' ? 'text-ink' : 'text-muted'}`}>{tag.value.text}</td>
              <td className={`${TD_CLASS} text-ink-2`}>{VALUE_STATE_LABELS[tag.value.state]}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                {tag.value.tsMs === null ? <span className="text-muted">—</span> : formatAgo(tag.value.tsMs, nowMs)}
              </td>
              <td className={`${TD_CLASS} text-xs text-muted`}>
                {[tag.binding === 'metric' ? '계장 태그 미기록 — 같은 자리 포인트로 연결' : null, tag.def.note ?? null]
                  .filter((note): note is string => note !== null)
                  .join(' · ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 공정도 상자에 걸리지 않는 열린 발견사항 (사이트 단위·도면에 없는 설비). 조용히 숨기지 않는다 */
export function OffDiagramFindings({ view }: Readonly<{ view: DiagramView }>) {
  if (view.offDiagramFindings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {view.offDiagramFindings.map((finding) => (
        <li key={finding.id} className="flex flex-wrap items-center gap-2 text-sm">
          <FindingSeverityChip severity={finding.severity} />
          <span className="font-mono text-xs text-muted">{finding.assetCode ?? '사이트 단위'}</span>
          <Link href={`/desk/${finding.id}`} className="text-ink hover:underline">
            {finding.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
