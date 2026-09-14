import type { ReactNode } from 'react';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { capacityBinLabel } from '@/lib/desk/conditions';
import type { CapacityEvidence, CellImbalanceEvidence, DqEvidence, PvPeerEvidence, StackEvidence } from '@/lib/desk/evidence-types';
import { formatSigned } from '@/lib/desk/effect';
import { formatKstDate, formatNumber } from '@/lib/format';

const Th = ({ children, right = false }: Readonly<{ children: ReactNode; right?: boolean }>) => (
  <th scope="col" className={`${TH_CLASS} ${right ? 'text-right' : ''}`}>
    {children}
  </th>
);

/** 같은 조건 비교표 (용량): bin마다 기준·최근 표본 수와 중앙값, 비율. 비교에 쓰지 않은 bin은 흐리게 */
export function CapacityBinsTable({ evidence }: Readonly<{ evidence: CapacityEvidence }>) {
  return (
    <TableScroll label="같은 조건 비교표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>{evidence.metric === 'rest_anchored' ? '조건 (방향 · 셀온도)' : '조건 (C-rate · 셀온도)'}</Th>
            <Th right>기준 n</Th>
            <Th right>기준 중앙값 (Ah)</Th>
            <Th right>최근 n</Th>
            <Th right>최근 중앙값 (Ah)</Th>
            <Th right>비율</Th>
            <Th>기준 기간</Th>
            <Th>비교</Th>
          </tr>
        </thead>
        <tbody>
          {evidence.bins.map((bin) => (
            <tr key={bin.key} className={bin.used ? undefined : 'text-muted'}>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{capacityBinLabel(bin.key, evidence.widths)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.nRef}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(bin.medRef, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.nCur}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(bin.medCur, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.ratio === null ? '—' : `${formatNumber(bin.ratio, 4)} (${formatSigned((bin.ratio - 1) * 100, 1)}%)`}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-xs`}>{bin.refFrom != null && bin.refTo != null ? `${formatKstDate(bin.refFrom)} ~ ${formatKstDate(bin.refTo)}` : '—'}</td>
              <td className={`${TD_CLASS} text-xs`}>{bin.used ? '사용' : bin.excluded === 'reference_spread' ? '기준 시점 차이로 제외' : '표본 부족'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 스택 같은 조건 구간: 구간별 정상운전 수·전압 중앙값·운전시간 범위 */
export function StackBinsTable({ evidence }: Readonly<{ evidence: StackEvidence }>) {
  return (
    <TableScroll label="같은 조건 비교표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>조건 (전류밀도 · 스택 온도)</Th>
            <Th right>정상운전 n</Th>
            <Th right>셀 전압 중앙값 (mV)</Th>
            <Th right>누적 운전시간 (h)</Th>
          </tr>
        </thead>
        <tbody>
          {evidence.bins.map((bin) => (
            <tr key={bin.key}>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{bin.label}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.n}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(bin.medianMv, 2)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                {formatNumber(bin.opHMin, 0)} ~ {formatNumber(bin.opHMax, 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 셀 전압 편차: 기준·최근 + 동종 랙 */
export function CellImbalanceTables({ evidence, assetCodes, selfLabel }: Readonly<{ evidence: CellImbalanceEvidence; assetCodes: ReadonlyMap<number, string>; selfLabel: string }>) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TableScroll label="같은 조건 비교표">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th>구간</Th>
              <Th right>n</Th>
              <Th right>편차 중앙값 (mV)</Th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['기준', evidence.reference],
                ['최근', evidence.recent],
              ] as const
            ).map(([label, row]) => (
              <tr key={label}>
                <td className={TD_CLASS}>{label}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.n}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.medianMv, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <TableScroll label="동종 비교표">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th>동종 랙</Th>
              <Th right>최근 편차 중앙값 (mV)</Th>
            </tr>
          </thead>
          <tbody>
            <tr className="font-medium">
              <td className={TD_CLASS}>
                {selfLabel} (이 랙{evidence.peers.modifiedZ === null ? '' : ` · 수정 z ${formatNumber(evidence.peers.modifiedZ, 2)}`})
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(evidence.recent.medianMv, 1)}</td>
            </tr>
            {evidence.peers.values.map((peer) => (
              <tr key={peer.assetId}>
                <td className={TD_CLASS}>{assetCodes.get(peer.assetId) ?? `설비 #${peer.assetId}`}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(peer.dvMv, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

/** 인버터 동종 비교 일별 표 */
export function PvPeerTable({ evidence }: Readonly<{ evidence: PvPeerEvidence }>) {
  return (
    <TableScroll label="동종 비교표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>날짜</Th>
            <Th right>kWh/kWp</Th>
            <Th right>동종 중앙값</Th>
            <Th right>편차</Th>
            <Th right>수정 z</Th>
            <Th right>동종 수</Th>
            <Th>판정</Th>
          </tr>
        </thead>
        <tbody>
          {evidence.days.map((day) => (
            <tr key={day.day} className={day.flagged ? 'font-medium' : undefined}>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{day.day}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(day.kwhPerKwp, 3)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(day.peerMedian, 3)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatSigned(day.deviationPct, 2)}%</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(day.modifiedZ, 2)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{day.peers ?? '—'}</td>
              <td className={`${TD_CLASS} text-xs ${day.flagged ? 'text-crit' : 'text-muted'}`}>{day.flagged ? '낮음' : '정상 범위'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 데이터 품질 포인트 요약 */
export function DqPointsTable({ evidence }: Readonly<{ evidence: DqEvidence }>) {
  return (
    <TableScroll label="데이터 품질 포인트 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>소스 태그</Th>
            <Th>메트릭</Th>
            <Th right>완결성</Th>
            <Th right>결측 합계 (h)</Th>
            <Th right>최장 고착 (h)</Th>
          </tr>
        </thead>
        <tbody>
          {evidence.points.map((point) => (
            <tr key={point.pointId}>
              <td className={`${TD_CLASS} font-mono text-xs`}>{point.sourceKey}</td>
              <td className={`${TD_CLASS} font-mono text-xs`}>{point.metricKey}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{point.completeness === null ? '—' : `${formatNumber(point.completeness * 100, 1)}%`}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(point.gapHours, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(point.longestFlatlineHours, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
