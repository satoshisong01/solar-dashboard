import { BRAND } from '@/lib/brand';
import type { ReportDetail } from '@/lib/data/reports';
import { detectorLabel } from '@/lib/desk/labels';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';
import { JUDGEMENT_LABELS, reportStatusLabel } from '@/lib/report/citations';
import { kpiDisplay } from '@/lib/report/kpi-labels';
import type { EvidencePack, PackFinding, PackSeries } from '@/lib/report/pack-types';
import type { ReviewDraft, ReviewSection } from '@/lib/report/review';
import { SeriesSvg } from './series-svg';

const TH = 'border-b border-rule-strong bg-sunken px-2 py-1 text-left text-[11px] font-semibold text-ink-2';
const TD = 'border-b border-rule px-2 py-1 align-top text-[12px]';

function FindingTable({ pack }: Readonly<{ pack: EvidencePack }>) {
  if (pack.findings.length === 0) return null;
  return (
    <table className="print-keep mt-2 w-full border-collapse">
      <caption className="pb-1 text-left text-[11px] text-muted">[표] 포함한 발견사항</caption>
      <thead>
        <tr>
          <th className={TH}>번호</th>
          <th className={TH}>설비</th>
          <th className={TH}>항목</th>
          <th className={`${TH} text-right`}>심각도</th>
          <th className={`${TH} text-right`}>신뢰도</th>
          <th className={TH}>판정</th>
        </tr>
      </thead>
      <tbody>
        {pack.findings.map((f) => (
          <tr key={f.id}>
            <td className={`${TD} font-mono`}>#{f.id}</td>
            <td className={`${TD} font-mono`}>{f.assetPath}</td>
            <td className={TD}>{detectorLabel(f.detectorId)}</td>
            <td className={`${TD} text-right`}>{f.severity}</td>
            <td className={`${TD} text-right`}>{Math.round(f.confidence * 100)}%</td>
            <td className={TD}>{JUDGEMENT_LABELS[f.judgement] ?? f.judgement}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KpiPrintTable({ pack }: Readonly<{ pack: EvidencePack }>) {
  if (pack.kpis.length === 0) return null;
  return (
    <table className="print-keep mt-2 w-full border-collapse">
      <caption className="pb-1 text-left text-[11px] text-muted">[표] 기간 KPI (om.kpi_daily)</caption>
      <thead>
        <tr>
          <th className={TH}>지표</th>
          <th className={TH}>범위</th>
          <th className={`${TH} text-right`}>일수</th>
          <th className={`${TH} text-right`}>합계</th>
          <th className={`${TH} text-right`}>평균</th>
          <th className={`${TH} text-right`}>최소 ~ 최대</th>
        </tr>
      </thead>
      <tbody>
        {pack.kpis.map((k) => {
          const d = kpiDisplay(k.key).digits;
          return (
            <tr key={k.key}>
              <td className={TD}>
                {k.label} ({k.unit})
              </td>
              <td className={TD}>{k.scope === 'site' ? '사이트' : `설비 ${k.assetCount}대`}</td>
              <td className={`${TD} text-right`}>{k.days}</td>
              <td className={`${TD} text-right`}>{formatNumber(k.total, d)}</td>
              <td className={`${TD} text-right`}>{formatNumber(k.mean, d)}</td>
              <td className={`${TD} text-right`}>
                {formatNumber(k.min, d)} ~ {formatNumber(k.max, d)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 발견사항 메시지 블록에 붙일 근거 요약 시계열 (판정 보류는 차트 없음) */
function chartSeries(pack: EvidencePack, blockId: string): { readonly finding: PackFinding; readonly series: PackSeries } | null {
  const finding = pack.findings.find((f) => blockId === `finding.${f.id}.message`);
  const series = finding && 'series' in finding.evidence ? finding.evidence.series : null;
  return finding && series && finding.judgement !== 'hold' ? { finding, series } : null;
}

function FindingChart({ finding, series, figure }: Readonly<{ finding: PackFinding; series: PackSeries; figure: number }>) {
  return (
    <figure className="print-keep my-2">
      <SeriesSvg series={series} label={`${finding.assetPath} ${series.yName} 근거 요약 차트`} />
      <figcaption className="text-center text-[10px] text-muted">
        [그림 {figure}] {finding.assetPath} · {series.yName} ({series.xKind === 'time' ? '날짜' : '누적 운전시간'} 축, 점 {series.points.length}개{series.line ? ', 빨간 선 = 추세' : ''})
      </figcaption>
    </figure>
  );
}

function Section({ section, index, pack }: Readonly<{ section: ReviewSection; index: number; pack: EvidencePack }>) {
  const included = section.blocks.filter((b) => b.included);
  const charts = section.kind === 'findings' ? included.flatMap((b) => (chartSeries(pack, b.id) ? [b.id] : [])) : [];
  return (
    <section className="mt-5">
      <h2 className="print-section-title border-b-2 border-accent pb-1 text-[15px] font-semibold text-accent">
        {index + 1}. {section.title}
      </h2>
      <div className="mt-2 flex flex-col gap-1.5">
        {included.length === 0 && <p className="text-[12px] text-muted">(검토에서 모든 문장을 제외했습니다)</p>}
        {included.map((block) => {
          const chart = charts.includes(block.id) ? chartSeries(pack, block.id) : null;
          return (
            <div key={block.id} className="print-keep">
              <p className={`text-[12.5px] leading-relaxed ${section.kind === 'safety' ? 'rounded border border-warn/50 bg-warn-fill px-2 py-1 font-medium text-warn' : 'text-ink'}`}>{block.text}</p>
              {chart && <FindingChart finding={chart.finding} series={chart.series} figure={charts.indexOf(block.id) + 1} />}
            </div>
          );
        })}
      </div>
      {section.kind === 'todo' && <FindingTable pack={pack} />}
      {section.kind === 'kpi' && <KpiPrintTable pack={pack} />}
    </section>
  );
}

/** 인쇄용 A4 리포트 본문: 머리말(회사·사이트·기간·작성일) · 포함한 블록 · 표 · 정적 SVG 차트 · 출처 */
export function PrintReport({ report, draft, pack }: Readonly<{ report: ReportDetail; draft: ReviewDraft; pack: EvidencePack }>) {
  const writtenAt = report.approvedAtMs ?? report.createdAtMs;
  return (
    <article className="print-sheet mx-auto w-full max-w-[210mm] rounded-sm border border-rule bg-surface px-4 py-6 text-ink shadow-sm sm:px-[12mm] sm:py-[12mm]">
      <header className="border-b border-rule-strong pb-3">
        <div className="flex items-baseline justify-between gap-4 text-[11px] text-muted">
          <span>
            {BRAND.company} · {BRAND.name}
          </span>
          <span className="font-mono">리포트 #{report.id}</span>
        </div>
        {report.status !== 'approved' && (
          <p className="mt-2 rounded border border-crit/50 bg-crit-fill px-2 py-1 text-[12px] font-semibold text-crit">
            {reportStatusLabel(report.status)} — {report.status === 'draft' ? '승인 전 초안입니다. 전달용으로 쓰지 마세요.' : '최신 리포트가 아닙니다.'}
          </p>
        )}
        <h1 className="mt-3 text-[22px] font-semibold tracking-tight">사이트 유지보수 코칭 리포트</h1>
        <p className="mt-1 text-[15px] text-ink-2">
          {pack.site.name} ({pack.site.code}) · {pack.period.label}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-0.5 text-[11.5px] sm:grid-cols-4">
          <div>
            <dt className="text-muted">기간</dt>
            <dd>
              {formatKstDate(pack.period.from)} ~ {formatKstDate(pack.period.lastDay)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">작성일</dt>
            <dd>{formatKstDate(writtenAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">작성</dt>
            <dd>{report.createdBy}</dd>
          </div>
          <div>
            <dt className="text-muted">승인</dt>
            <dd>{report.approvedBy ?? '—'}</dd>
          </div>
        </dl>
      </header>
      {draft.sections.map((section, index) => (
        <Section key={section.kind} section={section} index={index} pack={pack} />
      ))}
      <footer className="mt-6 border-t border-rule pt-2 text-[10px] leading-snug text-muted">
        문장: {draft.composerId} · 판정·우선순위: {pack.provenance.engineVersion} · 탐지기: {pack.provenance.detectorVersions.join(', ') || '—'}
        <br />
        근거 팩 {pack.provenance.packHash} · 팩 생성 {formatKstDateTime(pack.provenance.generatedAt)} KST · 인쇄 화면은 파일로 저장하지 않으며 전달은 별도로 합니다.
      </footer>
    </article>
  );
}
