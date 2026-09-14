// 정비 조치 CSV 가져오기 검증 (순수, 설계 §0 정비 이력 = 직접 기록 + CSV). P1 CSV 파서(lib/csv/parse.ts)를 쓴다.
// 헤더: site_code,asset_path,action_type,performed_at,performed_by,notes[,finding_id]
// 1단계 readActionCsv: 형식·열 수 (DB 없이) → 2단계 validateActionRows: 사이트·설비·발견사항·중복을 조회 결과(catalog)와 대조.
// 미리보기와 적용이 같은 함수를 쓰고, 적용 쪽은 미리보기를 믿지 않고 다시 검증한다. 오류가 한 행이라도 있으면 아무것도 넣지 않는다.
import { expectedEffectDefaults, verificationMetricsFor } from '@/lib/desk/action-defaults';
import { parseCsv } from '@/lib/csv/parse';
import { ACTION_FUTURE_DAYS_MAX, ACTION_NOTE_MAX, ACTION_TYPE_MAX, PERFORMED_BY_MAX } from '@/lib/forms/limits';
import { parseKstDay } from '@/lib/report/period';

export const ACTION_CSV_HEADER = ['site_code', 'asset_path', 'action_type', 'performed_at', 'performed_by', 'notes', 'finding_id'] as const;
/** finding_id 열은 선택 */
const REQUIRED_COLUMNS = ACTION_CSV_HEADER.length - 1;
export const ACTION_CSV_MAX_CHARS = 512_000;
export const ACTION_CSV_MAX_ROWS = 2_000;
const MAX_REPORTED_ERRORS = 50;
const DAY_MS = 86_400_000;
const CLOSED_STATUSES: readonly string[] = ['verified', 'dismissed'];

export interface CsvRowError {
  /** 파일 줄 번호 (헤더가 1행) */
  readonly line: number;
  readonly message: string;
}

export interface RawActionRow {
  readonly line: number;
  /** 이 행의 열 수와 헤더 열 수 (다르면 행 오류) */
  readonly columns: number;
  readonly expectedColumns: number;
  readonly siteCode: string;
  readonly assetPath: string;
  readonly actionType: string;
  readonly performedAt: string;
  readonly performedBy: string;
  readonly notes: string;
  readonly findingId: string;
}

export type ActionCsvRead = { readonly ok: true; readonly rows: readonly RawActionRow[] } | { readonly ok: false; readonly error: CsvRowError; readonly dataRows: number };

export interface CatalogAsset {
  readonly id: number;
  readonly siteId: number;
  readonly classKey: string;
}

export interface CatalogFinding {
  readonly siteId: number;
  readonly assetId: number | null;
  readonly status: string;
  readonly detectorId: string;
}

export interface ActionCsvCatalog {
  readonly sites: ReadonlyMap<string, number>;
  readonly assets: ReadonlyMap<string, CatalogAsset>;
  readonly findings: ReadonlyMap<string, CatalogFinding>;
  /** 이미 등록된 조치 (actionDuplicateKey) */
  readonly existing: ReadonlySet<string>;
}

export interface CsvExpectedEffect {
  readonly metric: string;
  readonly direction: 'increase' | 'decrease';
  readonly min_delta: number;
  readonly stabilization_days: number;
}

export interface ActionCsvRow {
  readonly line: number;
  readonly siteId: number;
  readonly siteCode: string;
  readonly assetId: number;
  readonly assetPath: string;
  readonly actionType: string;
  readonly performedAt: number;
  readonly performedBy: string | null;
  readonly notes: string | null;
  readonly findingId: string | null;
  readonly expectedEffect: CsvExpectedEffect | null;
}

export interface ActionCsvResult {
  readonly rows: readonly ActionCsvRow[];
  readonly errors: readonly CsvRowError[];
  readonly errorCount: number;
  readonly dataRows: number;
}

export const actionDuplicateKey = (assetId: number, actionType: string, performedAt: number): string => `${assetId}|${actionType.trim()}|${performedAt}`;

/** 'YYYY-MM-DD' · 'YYYY-MM-DD HH:mm' · 'YYYY-MM-DDTHH:mm' (KST) → epoch ms */
export function parseCsvDateTime(text: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const day = parseKstDay(match[1] ?? '');
  const [hour, minute] = [Number(match[2] ?? 0), Number(match[3] ?? 0)];
  if (day === null || hour > 23 || minute > 59) return null;
  return day + hour * 3_600_000 + minute * 60_000;
}

export function readActionCsv(text: string): ActionCsvRead {
  if (text.length > ACTION_CSV_MAX_CHARS) return { ok: false, error: { line: 1, message: `파일이 너무 큽니다 (최대 ${ACTION_CSV_MAX_CHARS.toLocaleString('ko-KR')}자)` }, dataRows: 0 };
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, error: { line: 1, message: parsed.error }, dataRows: 0 };
  const [header, ...data] = parsed.records;
  if (!header) return { ok: false, error: { line: 1, message: '내용이 없습니다' }, dataRows: 0 };
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const matches = (names.length === REQUIRED_COLUMNS || names.length === ACTION_CSV_HEADER.length) && names.every((name, i) => name === ACTION_CSV_HEADER[i]);
  if (!matches) return { ok: false, error: { line: header.line, message: `첫 줄은 헤더 ${ACTION_CSV_HEADER.slice(0, REQUIRED_COLUMNS).join(',')} (선택: ,finding_id) 이어야 합니다` }, dataRows: 0 };
  if (data.length === 0) return { ok: false, error: { line: header.line, message: '헤더 아래에 데이터 행이 없습니다' }, dataRows: 0 };
  if (data.length > ACTION_CSV_MAX_ROWS) return { ok: false, error: { line: header.line, message: `데이터 행은 최대 ${ACTION_CSV_MAX_ROWS.toLocaleString('ko-KR')}개입니다` }, dataRows: data.length };
  const width = names.length;
  return {
    ok: true,
    rows: data.map((record) => {
      const f = record.fields.map((v) => v.trim());
      return { line: record.line, columns: f.length, expectedColumns: width, siteCode: f[0] ?? '', assetPath: f[1] ?? '', actionType: f[2] ?? '', performedAt: f[3] ?? '', performedBy: f[4] ?? '', notes: f[5] ?? '', findingId: width === ACTION_CSV_HEADER.length ? (f[6] ?? '') : '' };
    }),
  };
}

type RowCheck = { readonly row: ActionCsvRow } | { readonly error: string };

function linkedFinding(raw: RawActionRow, siteId: number, asset: CatalogAsset, catalog: ActionCsvCatalog): { readonly id: string | null; readonly effect: CsvExpectedEffect | null } | { readonly error: string } {
  if (raw.findingId === '') return { id: null, effect: null };
  if (!/^[1-9]\d{0,17}$/.test(raw.findingId)) return { error: 'finding_id는 양의 정수여야 합니다' };
  const finding = catalog.findings.get(raw.findingId);
  if (!finding || finding.siteId !== siteId) return { error: `이 사이트에 발견사항 ${raw.findingId}이(가) 없습니다` };
  if (finding.assetId !== null && finding.assetId !== asset.id) return { error: `발견사항 ${raw.findingId}은(는) 다른 설비의 발견사항입니다` };
  if (CLOSED_STATUSES.includes(finding.status)) return { error: `발견사항 ${raw.findingId}은(는) 닫혀 있습니다. 먼저 다시 여세요` };
  // 연결한 발견사항의 탐지기 기본 검증 지표로 기대 효과를 채운다. 최소 변화량 0 = 기대 방향 변화가 유의하면(95% CI) 개선
  const defaults = expectedEffectDefaults(finding.detectorId, { baseline: null, current: null });
  const allowed = defaults !== null && verificationMetricsFor(asset.classKey).some((m) => m.key === defaults.metric);
  return { id: raw.findingId, effect: allowed && defaults ? { metric: defaults.metric, direction: defaults.direction, min_delta: 0, stabilization_days: defaults.stabilizationDays } : null };
}

function checkRow(raw: RawActionRow, catalog: ActionCsvCatalog, nowMs: number): RowCheck {
  if (raw.columns !== raw.expectedColumns) return { error: `열이 헤더와 같은 ${raw.expectedColumns}개여야 합니다 (지금 ${raw.columns}개)` };
  const siteId = catalog.sites.get(raw.siteCode);
  if (siteId === undefined) return { error: `site_code: 없는 사이트입니다 (${raw.siteCode || '빈 값'})` };
  const asset = catalog.assets.get(raw.assetPath);
  if (!asset || asset.siteId !== siteId) return { error: `asset_path: ${raw.siteCode}에 없는 설비입니다 (${raw.assetPath || '빈 값'})` };
  if (raw.actionType === '') return { error: 'action_type: 조치 종류를 입력하세요' };
  if (raw.actionType.length > ACTION_TYPE_MAX) return { error: `action_type: ${ACTION_TYPE_MAX}자 이하입니다` };
  const performedAt = parseCsvDateTime(raw.performedAt);
  if (performedAt === null) return { error: 'performed_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST)이어야 합니다' };
  if (performedAt > nowMs + ACTION_FUTURE_DAYS_MAX * DAY_MS) return { error: `performed_at: 예정일은 ${ACTION_FUTURE_DAYS_MAX}일 이내여야 합니다` };
  if (raw.performedBy.length > PERFORMED_BY_MAX) return { error: `performed_by: ${PERFORMED_BY_MAX}자 이하입니다` };
  if (raw.notes.length > ACTION_NOTE_MAX) return { error: `notes: ${ACTION_NOTE_MAX}자 이하입니다` };
  const link = linkedFinding(raw, siteId, asset, catalog);
  if ('error' in link) return { error: `finding_id: ${link.error}` };
  if (catalog.existing.has(actionDuplicateKey(asset.id, raw.actionType, performedAt))) return { error: '같은 설비·조치 종류·수행일시의 조치가 이미 등록되어 있습니다' };
  return {
    row: { line: raw.line, siteId, siteCode: raw.siteCode, assetId: asset.id, assetPath: raw.assetPath, actionType: raw.actionType, performedAt, performedBy: raw.performedBy === '' ? null : raw.performedBy, notes: raw.notes === '' ? null : raw.notes, findingId: link.id, expectedEffect: link.effect },
  };
}

export function validateActionRows(rows: readonly RawActionRow[], catalog: ActionCsvCatalog, nowMs: number): ActionCsvResult {
  const firstLineOf = new Map<string, number>();
  const checked = rows.map((raw) => {
    const check = checkRow(raw, catalog, nowMs);
    if ('error' in check) return { line: raw.line, error: check.error };
    const key = actionDuplicateKey(check.row.assetId, check.row.actionType, check.row.performedAt);
    const seenAt = firstLineOf.get(key);
    if (seenAt !== undefined) return { line: raw.line, error: `${seenAt}행과 설비·조치 종류·수행일시가 겹칩니다` };
    firstLineOf.set(key, raw.line);
    return { line: raw.line, row: check.row };
  });
  const errors = checked.flatMap((c) => ('error' in c && c.error !== undefined ? [{ line: c.line, message: c.error }] : []));
  return { rows: checked.flatMap((c) => ('row' in c && c.row ? [c.row] : [])), errors: errors.slice(0, MAX_REPORTED_ERRORS), errorCount: errors.length, dataRows: rows.length };
}

/** 한 번에: 형식 오류면 그 오류만, 아니면 행 검증 */
export function checkActionCsv(text: string, catalog: ActionCsvCatalog, nowMs: number): ActionCsvResult {
  const read = readActionCsv(text);
  if (!read.ok) return { rows: [], errors: [read.error], errorCount: 1, dataRows: read.dataRows };
  return validateActionRows(read.rows, catalog, nowMs);
}
