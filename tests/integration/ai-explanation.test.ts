// AI 설명 저장·재사용 (hysol_test): 같은 근거면 다시 부르지 않고, 근거가 바뀌면 새로 만든다.
// 실제 Gemini API는 부르지 않는다 — 제공자는 가짜다.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainSummary } from '@/lib/desk/plain';
import { engineLines } from '@/lib/llm/prompt';
import { fakeProvider, jsonReply, llmCase } from '@/lib/llm/test-fixtures';
import { aiEnabledFor, readAiSettings, setGlobalAiSetting, setSiteAiSetting } from '@/lib/ops/ai-settings';
import { getOrCreateExplanation, readExplanation, type ExplanationInput } from '@/lib/ops/finding-explanation';
import { createTestDb } from '../support/ingest-fixture';

const SITE_CODE = 'IT-AI';
const ADMIN = 'admin@hysol.local';
const CASE = llmCase('ess.capacity_fade');
const TEMPLATE = plainSummary(CASE.finding, CASE.evidence);
const LINES = engineLines(TEMPLATE);
const REWRITTEN = { ...LINES, what: `확인 결과, ${TEMPLATE.what}` };

describe('AI 설명 저장·재사용 (hysol_test)', () => {
  const db = createTestDb();
  let siteId = 0;
  let runId = '';
  let findingId = '';
  let evidenceId = '';

  const newEvidence = async (hash: string): Promise<string> => {
    const row = await db.insertInto('om.finding_evidence').values({ finding_id: findingId, run_id: runId, input_hash: hash, snapshot: '{}' }).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('om.finding').set({ latest_evidence_id: row.id }).where('id', '=', findingId).execute();
    return row.id;
  };

  const inputFor = (id: string, enabled = true): ExplanationInput => ({
    findingId,
    evidenceId: id,
    finding: { ...CASE.finding, category: 'degradation', assetPath: `${SITE_CODE}/ESS1/RACK01` },
    evidence: CASE.evidence,
    template: TEMPLATE,
    enabled,
  });

  const storedRows = () => db.selectFrom('om.finding_explanation').select(['evidence_id', 'source', 'model']).where('finding_id', '=', findingId).orderBy('evidence_id').execute();

  /** 이 테스트가 만든 행만 FK 순서로 지운다 (앞선 실행이 중간에 멈췄어도 다시 돌 수 있게) */
  async function dropFixture(): Promise<void> {
    const site = await db.selectFrom('om.site').select('id').where('code', '=', SITE_CODE).executeTakeFirst();
    if (!site) return;
    const findings = db.selectFrom('om.finding').select('id').where('site_id', '=', site.id);
    await db.deleteFrom('om.finding_explanation').where('finding_id', 'in', findings).execute();
    await db.deleteFrom('om.ai_explanation_setting').where((eb) => eb.or([eb('site_id', '=', site.id), eb('site_id', 'is', null)])).execute();
    await db.updateTable('om.finding').set({ latest_evidence_id: null }).where('site_id', '=', site.id).execute();
    await db.deleteFrom('om.finding_evidence').where('finding_id', 'in', findings).execute();
    await db.deleteFrom('om.finding').where('site_id', '=', site.id).execute();
    await sql`DELETE FROM om.analysis_run r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.scope -> 'siteIds') e(id) WHERE e.id::int = ${site.id})`.execute(db);
    await db.deleteFrom('om.site').where('id', '=', site.id).execute();
  }

  beforeAll(async () => {
    await dropFixture();
    const site = await db.insertInto('om.site').values({ code: SITE_CODE, name: 'AI 설명 테스트' }).returning('id').executeTakeFirstOrThrow();
    siteId = site.id;
    const run = await db
      .insertInto('om.analysis_run')
      .values({ requested_by: ADMIN, scope: JSON.stringify({ siteIds: [siteId], from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }), status: 'succeeded', started_at: new Date(Date.now() - 1000), finished_at: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    runId = run.id;
    const finding = await db
      .insertInto('om.finding')
      .values({
        site_id: siteId,
        detector_id: 'ess.capacity_fade',
        detector_version: 'ess.capacity_fade@1',
        failure_mode: 'ess.capacity_fade',
        category: 'degradation',
        dedup_key: `${SITE_CODE}|ess.capacity_fade`,
        severity: 3,
        confidence: 0.8,
        title: '배터리 랙 유효용량 감소',
        summary: '유효용량이 줄었습니다',
        effect: JSON.stringify({ metric: 'ess.capacity_ah', value: -6.2 }),
        window_start: new Date('2026-08-01T00:00:00Z'),
        window_end: new Date('2026-09-01T00:00:00Z'),
        first_detected_at: new Date('2026-09-01T00:00:00Z'),
        last_detected_at: new Date('2026-09-01T00:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    findingId = finding.id;
    evidenceId = await newEvidence('hash-1');
  });

  afterAll(async () => {
    await dropFixture();
    await db.destroy();
  });

  it('처음 볼 때 한 번 만들어 저장하고, 같은 근거면 다시 부르지 않는다', async () => {
    const provider = fakeProvider(jsonReply(REWRITTEN), 'fake-flash');

    const first = await getOrCreateExplanation(db, inputFor(evidenceId), provider);
    expect(first).toMatchObject({ source: 'llm', model: 'fake-flash', cached: false });
    expect(first.summary.what).toBe(REWRITTEN.what);

    const second = await getOrCreateExplanation(db, inputFor(evidenceId), provider);
    expect(second).toMatchObject({ source: 'llm', cached: true });
    expect(second.summary.what).toBe(REWRITTEN.what);
    expect(provider.requests).toHaveLength(1);
    expect(await storedRows()).toEqual([{ evidence_id: evidenceId, source: 'llm', model: 'fake-flash' }]);
  });

  it('근거가 바뀌면 새로 만든다 (예전 행은 남는다)', async () => {
    const provider = fakeProvider(jsonReply(REWRITTEN));
    const nextEvidenceId = await newEvidence('hash-2');

    const result = await getOrCreateExplanation(db, inputFor(nextEvidenceId), provider);

    expect(result).toMatchObject({ source: 'llm', cached: false });
    expect(provider.requests).toHaveLength(1);
    expect((await storedRows()).map((row) => row.evidence_id)).toEqual([evidenceId, nextEvidenceId]);
  });

  it('다시 생성은 저장된 행을 덮어쓴다', async () => {
    const provider = fakeProvider(jsonReply({ ...LINES, what: `다시 봐도, ${TEMPLATE.what}` }));

    const result = await getOrCreateExplanation(db, inputFor(evidenceId), provider, true);

    expect(result.summary.what).toBe(`다시 봐도, ${TEMPLATE.what}`);
    expect((await readExplanation(db, findingId, evidenceId))?.summary.what).toBe(`다시 봐도, ${TEMPLATE.what}`);
    expect(await storedRows()).toHaveLength(2);
  });

  it('검증에 걸린 문장은 틀 문장으로 저장하고 사유를 남긴다', async () => {
    const provider = fakeProvider(jsonReply({ ...LINES, what: `${TEMPLATE.what} 교체 비용은 1,200만 원입니다.` }));

    const result = await getOrCreateExplanation(db, inputFor(evidenceId), provider, true);

    expect(result.source).toBe('template');
    expect(result.summary).toEqual(TEMPLATE);
    const stored = await readExplanation(db, findingId, evidenceId);
    expect(stored?.source).toBe('template');
    expect(stored?.validation.reason).toBe('rejected');
    expect(stored?.validation.issues.map((issue) => issue.code)).toContain('untracked_number');
  });

  it('AI 설명을 끄면 부르지도, 저장하지도 않는다', async () => {
    const provider = fakeProvider(jsonReply(REWRITTEN));
    const otherEvidenceId = await newEvidence('hash-3');

    const result = await getOrCreateExplanation(db, inputFor(otherEvidenceId, false), provider);

    expect(result).toMatchObject({ source: 'template', validation: { reason: 'disabled' } });
    expect(provider.requests).toHaveLength(0);
    expect((await storedRows()).map((row) => row.evidence_id)).not.toContain(otherEvidenceId);
  });

  it('사이트 설정이 전역보다 앞서고, 설정이 없으면 키 유무를 따른다', async () => {
    expect(aiEnabledFor(await readAiSettings(db), siteId, true)).toBe(true);
    expect(aiEnabledFor(await readAiSettings(db), siteId, false)).toBe(false);

    await setGlobalAiSetting(db, { enabled: false, actor: ADMIN });
    expect(aiEnabledFor(await readAiSettings(db), siteId, true)).toBe(false);

    await setSiteAiSetting(db, { siteId, enabled: true, actor: ADMIN });
    expect(aiEnabledFor(await readAiSettings(db), siteId, true)).toBe(true);

    await setSiteAiSetting(db, { siteId, enabled: false, actor: ADMIN });
    await setGlobalAiSetting(db, { enabled: true, actor: ADMIN });
    expect(aiEnabledFor(await readAiSettings(db), siteId, true)).toBe(false);

    await setSiteAiSetting(db, { siteId, enabled: null, actor: ADMIN });
    expect(aiEnabledFor(await readAiSettings(db), siteId, false)).toBe(true);
  });
});
