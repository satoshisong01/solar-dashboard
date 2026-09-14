// 코칭 리포트·조치 추적 (hysol_test): 분석 → 리포트 만들기(멱등) → 검토(숫자 잠금 편집·제외) → 승인(in_report·superseded 체인)
// → 조치 CSV 가져오기 → 검증만 실행(저장된 에피소드 기준) → 분석 실행 뒤 효과 검증 → 검증된 조치가 리포트 팩에 들어간다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnalysis } from '@/lib/analysis/run';
import { registerMaintenanceAction } from '@/lib/analysis/transitions';
import { applyActionCsvRows, checkActionCsvText } from '@/lib/maintenance/store';
import { resolveReportPeriod } from '@/lib/report/period';
import { findBlock, parseReviewDraft } from '@/lib/report/review';
import { approveReport, createReport, editReportBlock, regenerateReport, ReportError, setReportBlockInclusion } from '@/lib/report/service';
import { readStoredPack } from '@/lib/report/evidence-pack';
import { ANALYSIS_BASE_MS, ANALYSIS_SITE, createAnalysisFixture, DAY_MS, dropAnalysisFixture, type AnalysisFixture } from '../support/analysis-fixture';
import { createTestDb } from '../support/ingest-fixture';

const DAYS = 30;
const STEP_DAY = 24;
const ADMIN = 'admin@hysol.local';
const at = (day: number): Date => new Date(ANALYSIS_BASE_MS + day * DAY_MS);
const august = resolveReportPeriod({ kind: 'month', month: '2026-08' });

describe('코칭 리포트·조치 추적 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: AnalysisFixture;
  let findingId: string;
  let reportId: string;
  if (!august.ok) throw new Error('period');
  const period = august.period;
  const reportRow = (id: string) => db.selectFrom('om.report').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const findingStatus = async () => (await db.selectFrom('om.finding').select('status').where('id', '=', findingId).executeTakeFirstOrThrow()).status;

  beforeAll(async () => {
    fixture = await createAnalysisFixture(db, DAYS, STEP_DAY);
    const result = await runAnalysis(db, { siteIds: [fixture.siteId], from: at(0), to: at(STEP_DAY), requestedBy: ADMIN }, { now: () => at(STEP_DAY) });
    expect(result.stats.sites[0]?.findings.created).toBe(1);
    findingId = (await db.selectFrom('om.finding').select('id').where('site_id', '=', fixture.siteId).executeTakeFirstOrThrow()).id;
  }, 180_000);

  afterAll(async () => {
    await dropAnalysisFixture(db);
    await db.destroy();
  });

  it('리포트 만들기: 팩 → 초안 → 검증 통과, 같은 입력이면 같은 행 (분석 실행 행은 늘지 않는다)', async () => {
    const runsBefore = await db.selectFrom('om.analysis_run').select('id').execute();
    const request = { siteId: fixture.siteId, period, findingIds: [findingId], includeVerifiedActions: true, actor: ADMIN };
    const first = await createReport(db, { ...request, now: at(STEP_DAY + 0.1) });
    expect(first).toMatchObject({ created: true, status: 'draft', validation: { ok: true, issues: [] } });
    const again = await createReport(db, { ...request, now: at(STEP_DAY + 0.2) });
    expect(again).toMatchObject({ created: false, reportId: first.reportId });
    expect(await db.selectFrom('om.analysis_run').select('id').execute()).toHaveLength(runsBefore.length);

    const row = await reportRow(first.reportId);
    expect(row).toMatchObject({ site_id: fixture.siteId, composer_id: 'templateComposer@1', status: 'draft', created_by: ADMIN });
    const pack = readStoredPack(row.pack);
    expect(pack?.provenance.packHash).toBe(row.pack_hash);
    expect(pack?.findings.map((f) => [f.id, f.detectorId, f.judgement])).toEqual([[findingId, 'el.voltage_rise', 'provisional']]);
    const draft = parseReviewDraft(row.draft);
    expect(findBlock(draft ?? { composerId: '', packHash: '', title: '', sections: [] }, `finding.${findingId}.message`)?.text).toMatch(new RegExp(`^\\[${ANALYSIS_SITE}/ELZ1/STACK1\\] 전해조 셀 전압 상승 \\(잠정, 신뢰도 \\d+%·탐지 1회\\): .* µV/h\\(95% CI .*\\)로 상승하고 있습니다`));
    reportId = first.reportId;
  }, 60_000);

  it('검토: 숫자를 바꾸면 거절, 문장만 바꾸거나 블록을 사유와 함께 빼면 저장·재검증', async () => {
    const draft = parseReviewDraft((await reportRow(reportId)).draft);
    const message = draft ? findBlock(draft, `finding.${findingId}.message`) : null;
    const number = message?.numberTokens.find((t) => t.format === 'number' && /\./.test(t.text));
    expect(number).toBeDefined();
    await expect(editReportBlock(db, { reportId, blockId: `finding.${findingId}.message`, text: message?.text.replace(number?.text ?? '', '99.9') ?? '', actor: ADMIN, now: at(STEP_DAY + 0.3) })).rejects.toThrow('숫자는 편집할 수 없습니다');
    const reworded = await editReportBlock(db, { reportId, blockId: `finding.${findingId}.message`, text: (message?.text ?? '').replace('상승하고 있습니다.', '오르는 추세입니다.'), actor: ADMIN, now: at(STEP_DAY + 0.3) });
    expect(reworded.ok).toBe(true);
    const kpiBlockId = parseReviewDraft((await reportRow(reportId)).draft)?.sections.find((s) => s.kind === 'kpi')?.blocks[0]?.id ?? '';
    await expect(setReportBlockInclusion(db, { reportId, blockId: kpiBlockId, included: false, reason: ' ', actor: ADMIN, now: at(STEP_DAY + 0.3) })).rejects.toThrow(ReportError);
    expect(await setReportBlockInclusion(db, { reportId, blockId: kpiBlockId, included: false, reason: '표로 대체', actor: ADMIN, now: at(STEP_DAY + 0.3) })).toMatchObject({ ok: true });
    const stored = parseReviewDraft((await reportRow(reportId)).draft);
    expect(stored && findBlock(stored, `finding.${findingId}.message`)?.text).toContain('오르는 추세입니다.');
    expect(stored?.sections.find((s) => s.kind === 'kpi')?.blocks[0]).toMatchObject({ included: false, excludeReason: '표로 대체', editedBy: ADMIN });
  }, 60_000);

  it('승인: 포함한 발견사항 in_report, 승인 뒤 편집 불가, 새 초안을 승인하면 이전 승인본은 superseded', async () => {
    const approved = await approveReport(db, { reportId, actor: ADMIN, now: at(STEP_DAY + 0.4) });
    expect(approved).toMatchObject({ moved: [findingId], skipped: [], superseded: 0 });
    expect(await reportRow(reportId)).toMatchObject({ status: 'approved', approved_by: ADMIN });
    expect(await findingStatus()).toBe('in_report');
    const note = await db.selectFrom('om.finding_transition').select(['to_status', 'note', 'actor']).where('finding_id', '=', findingId).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(note).toEqual({ to_status: 'in_report', note: `리포트 #${reportId} 승인`, actor: ADMIN });
    await expect(editReportBlock(db, { reportId, blockId: 'safety.notice', text: 'x', actor: ADMIN, now: at(STEP_DAY + 0.5) })).rejects.toThrow('승인한 리포트는 편집할 수 없습니다');

    const next = await regenerateReport(db, { reportId, actor: ADMIN, now: at(STEP_DAY + 0.5) });
    expect(next).toMatchObject({ created: true, status: 'draft' });
    expect(next.reportId).not.toBe(reportId);
    expect(await regenerateReport(db, { reportId, actor: ADMIN, now: at(STEP_DAY + 0.55) })).toMatchObject({ created: false, reportId: next.reportId });
    expect(readStoredPack((await reportRow(next.reportId)).pack)?.selection.basedOnReportId).toBe(reportId);
    const second = await approveReport(db, { reportId: next.reportId, actor: ADMIN, now: at(STEP_DAY + 0.6) });
    expect(second).toMatchObject({ moved: [], skipped: [findingId], superseded: 1 });
    expect((await reportRow(reportId)).status).toBe('superseded');
    expect((await reportRow(next.reportId)).status).toBe('approved');
  }, 60_000);

  it('조치 CSV: 행 오류가 있으면 적용하지 않고, 정상이면 한 트랜잭션으로 넣고 연결 발견사항은 조치 완료', async () => {
    const header = 'site_code,asset_path,action_type,performed_at,performed_by,notes,finding_id';
    const good = `${ANALYSIS_SITE},${ANALYSIS_SITE}/ELZ1/STACK1,루프 이온교환수지 교체,2026-08-25 10:00,현장팀,,${findingId}`;
    const withError = await checkActionCsvText(db, [header, good, `${ANALYSIS_SITE},${ANALYSIS_SITE}/NOPE,점검,2026-08-25,,,`].join('\n'), at(STEP_DAY).getTime());
    expect(withError).toMatchObject({ errorCount: 1, errors: [{ line: 3, message: expect.stringContaining('없는 설비') }] });

    const checked = await checkActionCsvText(db, [header, good].join('\n'), at(STEP_DAY).getTime());
    expect(checked.errorCount).toBe(0);
    expect(checked.rows[0]?.expectedEffect).toEqual({ metric: 'el.v_cell_v', direction: 'decrease', min_delta: 0, stabilization_days: 7 });
    expect(await applyActionCsvRows(db, checked.rows, ADMIN)).toEqual({ inserted: 1, transitioned: 1, withExpectedEffect: 1 });
    expect(await findingStatus()).toBe('action_taken');
    const action = await db.selectFrom('om.maintenance_action').selectAll().where('site_id', '=', fixture.siteId).executeTakeFirstOrThrow();
    expect(action).toMatchObject({ source: 'csv', created_by: ADMIN, performed_by: '현장팀', finding_id: findingId });
    expect((await checkActionCsvText(db, [header, good].join('\n'), at(STEP_DAY).getTime())).errors[0]?.message).toContain('이미 등록');
  }, 60_000);

  it('검증만 실행은 저장된 에피소드만 쓴다 → 분석 실행으로 후 창 에피소드를 채우면 improved → verified, 리포트 팩에 검증된 조치', async () => {
    const effect = { metric: 'el.v_cell_v', direction: 'decrease' as const, min_delta: 0.005, stabilization_days: 1, window_days: 4 };
    const manual = await registerMaintenanceAction(db, { siteId: fixture.siteId, assetId: fixture.stackId, findingId, actionType: '스택 재체결', performedAt: at(STEP_DAY), expectedEffect: effect, source: 'manual', actor: ADMIN });
    const episodesBefore = await db.selectFrom('om.episode').select('start_ts').where('asset_id', '=', fixture.stackId).execute();

    const verifyOnly = await runAnalysis(db, { siteIds: [fixture.siteId], assetIds: [fixture.stackId], from: at(STEP_DAY - 5), to: at(DAYS), requestedBy: ADMIN }, { now: () => at(DAYS), stages: 'verify' });
    expect(verifyOnly.status).toBe('succeeded');
    expect(verifyOnly.stats.sites[0]).toMatchObject({ episodesSaved: 0, kpiRows: 0, findings: { created: 0, updated: 0 }, verification: { checked: 1, pending: 1, verdicts: { insufficient_data: 1 } } });
    expect(await db.selectFrom('om.episode').select('start_ts').where('asset_id', '=', fixture.stackId).execute()).toHaveLength(episodesBefore.length);
    const run = await db.selectFrom('om.analysis_run').select('scope').where('id', '=', verifyOnly.runId).executeTakeFirstOrThrow();
    expect(run.scope).toMatchObject({ mode: 'verify' });

    const full = await runAnalysis(db, { siteIds: [fixture.siteId], from: at(0), to: at(DAYS), requestedBy: ADMIN }, { now: () => at(DAYS) });
    expect(full.stats.sites[0]?.verification).toMatchObject({ checked: 1, verdicts: { improved: 1 }, verifiedFindings: 1 });
    expect(await findingStatus()).toBe('verified');
    const verification = await db.selectFrom('om.action_verification').select(['verdict']).where('action_id', '=', manual.actionId).executeTakeFirstOrThrow();
    expect(verification.verdict).toBe('improved');

    const report = await createReport(db, { siteId: fixture.siteId, period, findingIds: [findingId], includeVerifiedActions: true, actor: ADMIN, now: at(DAYS) });
    expect(report.validation.ok).toBe(true);
    const pack = readStoredPack((await reportRow(report.reportId)).pack);
    expect(pack?.verifiedActions).toEqual([expect.objectContaining({ actionType: '스택 재체결', verdict: 'improved', metric: 'el.v_cell_v', unit: 'V' })]);
    const block = parseReviewDraft((await reportRow(report.reportId)).draft)?.sections.find((s) => s.kind === 'verified_actions')?.blocks[0];
    expect(block?.text).toMatch(/조치 "스택 재체결"\(수행 2026-08-25\): 전해조 셀 평균 전압 −0\.\d+ V\(95% CI .+, 전 \d+회·후 \d+회 비교\) → 개선 확인\./);
  }, 240_000);
});
