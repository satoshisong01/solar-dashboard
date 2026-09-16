import Link from 'next/link';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { ParamField } from '@/lib/detector-config/types';
import { formatParamValue } from '@/lib/detector-config/types';
import type { TrustBadge } from '@/lib/desk/scorecard';
import { formatNumber } from '@/lib/format';

export interface DetectorListRow {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly failureMode: string;
  readonly failureModeTitle: string;
  readonly categoryLabel: string;
  readonly unitLabel: string;
  readonly assetClasses: readonly string[];
  /** 'stack.current ≤60초' 형식의 메트릭별 요건 문구 (권장 메트릭은 '(권장)' 표시) */
  readonly metrics: readonly string[];
  readonly badge: TrustBadge;
  readonly activeScopes: number;
}

/** 스코어카드 요약 한 줄 (재현율 · 최소 탐지 크기 · 오탐/자산·월) */
export function ScoreSummary({ badge }: Readonly<{ badge: TrustBadge }>) {
  if (badge.kind === 'none') return <span className="text-xs text-muted">평가 결과 없음</span>;
  return (
    <span className="flex flex-col gap-0.5 text-xs text-ink-2">
      <span>재현율 {badge.recall === null ? '—' : `${formatNumber(badge.recall * 100, 0)}%`}</span>
      <span>최소 탐지 크기 {badge.minDetectable ?? '—'}</span>
      <span>오탐 {badge.fpPerAssetMonth === null ? '—' : `${formatNumber(badge.fpPerAssetMonth, 3)}건/자산·월`}</span>
    </span>
  );
}

export function DetectorListTable({ rows }: Readonly<{ rows: readonly DetectorListRow[] }>) {
  return (
    <TableScroll label="탐지기 목록 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>탐지기</th>
            <th scope="col" className={TH_CLASS}>고장모드 · 카테고리</th>
            <th scope="col" className={TH_CLASS}>대상 · 요구 메트릭</th>
            <th scope="col" className={TH_CLASS}>스코어카드 (시뮬레이터)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>활성 설정 범위</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className={`${TD_CLASS} font-normal`}>
                <Link href={`/settings/detectors/${encodeURIComponent(row.id)}`} className="font-medium text-accent hover:underline">
                  {row.label}
                </Link>
                <span className="block font-mono text-xs text-muted">
                  {row.id}@{row.version}
                </span>
              </th>
              <td className={TD_CLASS}>
                <span className="block text-ink">{row.failureModeTitle}</span>
                <span className="block text-xs text-muted">
                  <span className="font-mono">{row.failureMode}</span> · {row.categoryLabel}
                </span>
              </td>
              <td className={TD_CLASS}>
                <span className="block w-64 text-xs whitespace-normal text-ink-2">
                  {row.unitLabel} · {row.assetClasses.length === 0 ? '모든 설비' : row.assetClasses.join(', ')}
                </span>
                <span className="block w-64 font-mono text-xs break-words whitespace-normal text-muted">{row.metrics.length === 0 ? '(포인트 전체)' : row.metrics.join(', ')}</span>
              </td>
              <td className={TD_CLASS}>
                <ScoreSummary badge={row.badge} />
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.activeScopes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 코드 기본값 표 (paramSchema 선언 순서) */
export function DefaultParamsTable({ fields }: Readonly<{ fields: readonly ParamField[] }>) {
  return (
    <TableScroll label="코드 기본값 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>파라미터</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>기본값</th>
            <th scope="col" className={TH_CLASS}>단위</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>범위</th>
            <th scope="col" className={TH_CLASS}>설명</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.key}>
              <th scope="row" className={`${TD_CLASS} font-normal`}>
                <span className="block text-ink">{field.label}</span>
                <span className="block font-mono text-xs text-muted">{field.key}</span>
              </th>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatParamValue(field.defaultValue)}</td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>{field.unit === '' ? '—' : field.unit}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} text-xs`}>{field.kind === 'choice' ? field.options.join(' | ') : field.kind === 'boolean' ? '켜기 | 끄기' : `${field.min ?? '−∞'} ~ ${field.max ?? '∞'}${field.nullable ? ' · 비움 가능' : ''}`}</td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>
                <span className="block w-80 whitespace-normal">{field.description}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
