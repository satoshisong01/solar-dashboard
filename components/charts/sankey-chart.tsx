'use client';

import { SankeyChart } from 'echarts/charts';
import { use as registerChartParts } from 'echarts/core';
import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { ChartTone } from '@/lib/data/domains';
import type { SankeyData, SankeyLink, SankeyNode } from '@/lib/chain/sankey';
import { formatNumber } from '@/lib/format';

// Sankey 시리즈는 이 차트를 쓰는 화면에서만 등록한다 (공용 래퍼 번들에 넣지 않음).
registerChartParts([SankeyChart]);

/** 노드 id → 도메인 톤. 노드마다 이름·값 라벨이 붙으므로 색은 무리(태양광·수소·계통) 구분만 한다. 없는 id·미계측은 흐린 회색 */
export type SankeyToneMap = Readonly<Record<string, ChartTone>>;

type Props = Readonly<{
  data: SankeyData;
  unit: string;
  tones: SankeyToneMap;
  ariaLabel: string;
  /** 흐름 툴팁 끝에 붙는 안내 (예: 비례 할당 가정) */
  linkNote?: string;
  className?: string;
}>;

const DIGITS: Readonly<Record<string, number>> = { kWh: 0, kg: 1 };

function colorOf(theme: ChartTheme, tones: SankeyToneMap, node: SankeyNode | undefined, edge: boolean): string {
  if (!node || node.unmetered) return theme.muted;
  const tone = tones[node.id];
  return tone ? theme.tones[tone][edge ? 1 : 0] : theme.muted;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function tooltipText(data: SankeyData, unit: string, linkNote: string | undefined, raw: unknown): string {
  const item = typeof raw === 'object' && raw !== null ? (raw as { dataType?: string; data?: Partial<SankeyLink> & { name?: string } }) : {};
  const label = (id: string | undefined) => data.nodes.find((n) => n.id === id)?.label ?? id ?? '';
  const digits = DIGITS[unit] ?? 1;
  if (item.dataType === 'edge' && item.data) {
    const link = data.links.find((l) => l.source === item.data?.source && l.target === item.data?.target);
    if (!link) return '';
    const share = data.total > 0 ? ` (${formatNumber((link.value / data.total) * 100, 1)}%)` : '';
    const lines = [`${escapeHtml(label(link.source))} → ${escapeHtml(label(link.target))}`, `${formatNumber(link.value, digits)} ${unit}${share}${link.unmetered ? ' · 계측 불일치' : ''}`];
    return [...lines, ...(linkNote ? [`<span style="opacity:.75">${escapeHtml(linkNote)}</span>`] : [])].join('<br/>');
  }
  const node = data.nodes.find((n) => n.id === item.data?.name);
  return node ? `${escapeHtml(node.label)}<br/>${formatNumber(node.value, digits)} ${unit}` : '';
}

function buildOption(theme: ChartTheme, data: SankeyData, unit: string, tones: SankeyToneMap, linkNote: string | undefined): EChartOption {
  const digits = DIGITS[unit] ?? 1;
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.rule,
      textStyle: { color: theme.ink, fontSize: 12 },
      extraCssText: 'max-width:22rem;white-space:normal;',
      formatter: (params: unknown) => tooltipText(data, unit, linkNote, params),
    },
    series: [
      {
        type: 'sankey',
        left: 8,
        right: 8,
        top: 8,
        bottom: 8,
        nodeWidth: 12,
        nodeGap: 20,
        draggable: false,
        emphasis: { focus: 'adjacency' },
        data: data.nodes.map((node) => ({
          name: node.id,
          depth: node.side === 'supply' ? 0 : 1,
          itemStyle: { color: colorOf(theme, tones, node, false), borderColor: theme.surface, borderWidth: 1 },
          label: {
            position: node.side === 'supply' ? 'right' : 'left',
            color: theme.ink,
            fontSize: 12,
            formatter: `${node.label}  ${formatNumber(node.value, digits)} ${unit}`,
          },
        })),
        links: data.links.map((link) => ({
          source: link.source,
          target: link.target,
          value: link.value,
          lineStyle: link.unmetered ? { color: theme.muted, opacity: 0.18 } : { color: colorOf(theme, tones, byId.get(link.source), true), opacity: 0.38 },
        })),
        lineStyle: { curveness: 0.5 },
      },
    ],
  };
}

/** 체인 원장 Sankey (공급 → 수요 2단). 노드 라벨에 이름과 기간 합을 직접 적는다 */
export function ChainSankeyChart({ data, unit, tones, ariaLabel, linkNote, className = 'h-[28rem] w-full' }: Props) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildOption(theme, data, unit, tones, linkNote) : null), [theme, data, unit, tones, linkNote]);
  return <EChart option={option} className={className} ariaLabel={ariaLabel} />;
}
