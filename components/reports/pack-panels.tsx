import Link from 'next/link';
import { FindingSeverityChip } from '@/components/desk/finding-badges';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { statusLabel, isFindingStatus } from '@/lib/analysis/transition-rules';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { JUDGEMENT_LABELS } from '@/lib/report/citations';
import { kpiDisplay } from '@/lib/report/kpi-labels';
import type { EvidencePack } from '@/lib/report/pack-types';
import type { StoredValidationView } from '@/lib/report/citations';
import { ValidationBadge } from './report-badges';

/** 검증기 결과 패널: 문제는 블록으로 가는 링크와 함께 */
export function ValidationSummary({ validation }: Readonly<{ validation: StoredValidationView }>) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <ValidationBadge ok={validation.ok} issueCount={validation.issues.length} />
        검사한 블록 {validation.checkedBlocks}개{validation.checkedAt !== null && ` · ${formatKstDateTime(validation.checkedAt)} KST`}
      </p>
      <p className="text-xs text-muted">규칙: 인용 근거가 팩에 있음 · 본문 숫자 = 근거 값(표시 반올림 허용) · 심각도 4 이상 발견사항 모두 언급 · 금지 표현(법정 안전 판단 대체 등) 없음 · 안전 고정 문구 포함</p>
      {validation.issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit">
          {validation.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              {issue.blockId ? (
                <a href={`#block-${issue.blockId}`} className="underline">
                  {issue.blockId}
                </a>
              ) : (
                '리포트 전체'
              )}
              : {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 팩에 들어간 발견사항 (판정·우선순위 포함) */
export function PackFindingsTable({ pack }: Readonly<{ pack: EvidencePack }>) {
  if (pack.findings.length === 0) return <EmptyNote>포함한 발견사항이 없습니다</EmptyNote>;
  return (
    <TableScroll label="팩 발견사항 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>발견사항</th>
            <th scope="col" className={TH_CLASS}>심각도</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>신뢰도</th>
            <th scope="col" className={TH_CLASS}>판정</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>우선순위</th>
            <th scope="col" className={TH_CLASS}>팩 생성 시 상태</th>
          </tr>
        </thead>
        <tbody>
          {pack.findings.map((f) => (
            <tr key={f.id}>
              <td className={TD_CLASS}>
                <Link href={`/desk/${f.id}`} className="font-medium text-ink underline">
                  #{f.id} {f.detectorLabel}
                </Link>
                <span className="block font-mono text-xs text-muted">{f.assetPath}</span>
              </td>
              <td className={TD_CLASS}>
                <FindingSeverityChip severity={f.severity} />
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{Math.round(f.confidence * 100)}%</td>
              <td className={TD_CLASS}>{JUDGEMENT_LABELS[f.judgement] ?? f.judgement}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(f.priority, 2)}</td>
              <td className={`${TD_CLASS} text-ink-2`}>{isFindingStatus(f.status) ? statusLabel(f.status) : f.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** KPI 요약 표 (검토·인쇄 공용) */
export function KpiTable({ pack }: Readonly<{ pack: EvidencePack }>) {
  if (pack.kpis.length === 0) return <EmptyNote>기간 KPI가 없습니다</EmptyNote>;
  return (
    <TableScroll label="KPI 요약 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>지표</th>
            <th scope="col" className={TH_CLASS}>범위</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>일수</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>합계</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>평균</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>최소 ~ 최대</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>완결성</th>
          </tr>
        </thead>
        <tbody>
          {pack.kpis.map((k) => {
            const digits = kpiDisplay(k.key).digits;
            return (
              <tr key={k.key}>
                <td className={TD_CLASS}>
                  {k.label} <span className="text-xs text-muted">{k.unit}</span>
                </td>
                <td className={`${TD_CLASS} text-ink-2`}>{k.scope === 'site' ? '사이트' : `설비 ${k.assetCount}대`}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{k.days}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(k.total, digits)}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(k.mean, digits)}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                  {formatNumber(k.min, digits)} ~ {formatNumber(k.max, digits)}
                </td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{k.completenessPct === null ? '—' : `${formatNumber(k.completenessPct, 1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 팩 출처: 엔진·탐지기 버전, 생성 시각, 해시 */
export function PackProvenance({ pack }: Readonly<{ pack: EvidencePack }>) {
  const p = pack.provenance;
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted">스키마 · 엔진</dt>
        <dd className="font-mono text-xs text-ink-2">
          {p.schema} · {p.engineVersion} · {p.kpiCalcVersion}
          {p.templateVersion ? ` · ${p.templateVersion}` : ''}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">팩 생성</dt>
        <dd className="font-mono text-xs text-ink-2">{formatKstDateTime(p.generatedAt)} KST</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">팩 해시</dt>
        <dd className="font-mono text-xs break-all text-ink-2">{p.packHash}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">탐지기</dt>
        <dd className="font-mono text-xs text-ink-2">{p.detectorVersions.length === 0 ? '—' : p.detectorVersions.join(', ')}</dd>
      </div>
    </dl>
  );
}
