// 외부 수소 반입 기록 CSV 가져오기 검증 (순수, 서버·클라이언트 공용). 정비 조치 CSV(lib/maintenance/action-csv.ts)와 같은 2단계 구조다.
// 헤더: site_code,delivered_at,supplier,vehicle_no,mass_kg[,heel_mass_kg,unit_price_krw,amount_krw,purity_pct,note]
//   1단계 readDeliveryCsv: 형식·열 수 (DB 없이) → 2단계 validateDeliveryRows: 사이트 코드와 이미 등록된 건을 조회 결과(catalog)와 대조.
// 미리보기와 적용이 같은 함수를 쓰고, 적용 쪽은 미리보기를 믿지 않고 다시 검증한다. 오류가 한 행이라도 있으면 아무것도 넣지 않는다.
import { parseCsv } from '@/lib/csv/parse';
import { DELIVERY_NOTE_MAX, SUPPLIER_MAX, VEHICLE_NO_MAX } from '@/lib/forms/limits';
import { parseCsvDateTime, type CsvRowError } from '@/lib/maintenance/action-csv'; // 날짜 형식 규칙을 정비 CSV와 하나로 유지한다

export const DELIVERY_CSV_HEADER = ['site_code', 'delivered_at', 'supplier', 'vehicle_no', 'mass_kg', 'heel_mass_kg', 'unit_price_krw', 'amount_krw', 'purity_pct', 'note'] as const;
/** 앞 5열은 반드시 있어야 한다. 뒤 5열은 이 순서대로 원하는 만큼만 붙일 수 있다 */
export const DELIVERY_CSV_REQUIRED_COLUMNS = 5;
export const DELIVERY_CSV_MAX_CHARS = 512_000;
export const DELIVERY_CSV_MAX_ROWS = 2_000;
const MAX_REPORTED_ERRORS = 50;

export type { CsvRowError };

export interface RawDeliveryRow {
  /** 파일 줄 번호 (헤더가 1행) */
  readonly line: number;
  readonly columns: number;
  readonly expectedColumns: number;
  readonly siteCode: string;
  readonly deliveredAt: string;
  readonly supplier: string;
  readonly vehicleNo: string;
  readonly massKg: string;
  readonly heelMassKg: string;
  readonly unitPriceKrw: string;
  readonly amountKrw: string;
  readonly purityPct: string;
  readonly note: string;
}

export type DeliveryCsvRead = { readonly ok: true; readonly rows: readonly RawDeliveryRow[] } | { readonly ok: false; readonly error: CsvRowError; readonly dataRows: number };

export interface DeliveryCsvCatalog {
  readonly sites: ReadonlyMap<string, number>;
  /** 이미 등록된 반입 건 (deliveryDuplicateKey) */
  readonly existing: ReadonlySet<string>;
}

export interface DeliveryCsvRow {
  readonly line: number;
  readonly siteId: number;
  readonly siteCode: string;
  /** epoch ms (KST 해석) */
  readonly deliveredAt: number;
  readonly supplier: string;
  readonly vehicleNo: string | null;
  readonly massKg: number;
  readonly heelMassKg: number | null;
  readonly unitPriceKrw: number | null;
  readonly amountKrw: number | null;
  readonly purityPct: number | null;
  readonly note: string | null;
}

export interface DeliveryCsvResult {
  readonly rows: readonly DeliveryCsvRow[];
  readonly errors: readonly CsvRowError[];
  readonly errorCount: number;
  readonly dataRows: number;
}

/** 중복 판정 키 — DB 유니크 인덱스 h2_delivery_dedupe_key와 같은 조합이다 */
export const deliveryDuplicateKey = (siteId: number, deliveredAt: number, supplier: string, vehicleNo: string | null): string =>
  `${siteId}|${deliveredAt}|${supplier.trim()}|${vehicleNo ?? ''}`;

interface NumberField {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** 하한을 포함하지 않는다 (0 초과) */
  readonly exclusiveMin?: true;
}

type NumberCheck = { readonly value: number | null } | { readonly error: string };

/** 빈 값은 null. 천 단위 쉼표는 지운다 (전표 값을 그대로 옮겨 적는 경우가 많다) */
export function optionalNumber(text: string, field: NumberField): NumberCheck {
  if (text === '') return { value: null };
  const value = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(value)) return { error: `${field.label}: 숫자여야 합니다` };
  const belowMin = field.exclusiveMin === true ? value <= field.min : value < field.min;
  if (belowMin) return { error: `${field.label}: ${field.min}${field.exclusiveMin === true ? ' 초과' : ' 이상'}여야 합니다` };
  if (value > field.max) return { error: `${field.label}: ${field.max.toLocaleString('ko-KR')} 이하여야 합니다` };
  return { value };
}

const headerMessage = `첫 줄은 헤더 ${DELIVERY_CSV_HEADER.slice(0, DELIVERY_CSV_REQUIRED_COLUMNS).join(',')} (뒤에 ${DELIVERY_CSV_HEADER.slice(DELIVERY_CSV_REQUIRED_COLUMNS).join(',')} 순서로 더 붙일 수 있습니다) 이어야 합니다`;

export function readDeliveryCsv(text: string): DeliveryCsvRead {
  if (text.length > DELIVERY_CSV_MAX_CHARS) return { ok: false, error: { line: 1, message: `파일이 너무 큽니다 (최대 ${DELIVERY_CSV_MAX_CHARS.toLocaleString('ko-KR')}자)` }, dataRows: 0 };
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, error: { line: 1, message: parsed.error }, dataRows: 0 };
  const [header, ...data] = parsed.records;
  if (!header) return { ok: false, error: { line: 1, message: '내용이 없습니다' }, dataRows: 0 };
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const width = names.length;
  const matches = width >= DELIVERY_CSV_REQUIRED_COLUMNS && width <= DELIVERY_CSV_HEADER.length && names.every((name, i) => name === DELIVERY_CSV_HEADER[i]);
  if (!matches) return { ok: false, error: { line: header.line, message: headerMessage }, dataRows: 0 };
  if (data.length === 0) return { ok: false, error: { line: header.line, message: '헤더 아래에 데이터 행이 없습니다' }, dataRows: 0 };
  if (data.length > DELIVERY_CSV_MAX_ROWS) return { ok: false, error: { line: header.line, message: `데이터 행은 최대 ${DELIVERY_CSV_MAX_ROWS.toLocaleString('ko-KR')}개입니다` }, dataRows: data.length };
  return {
    ok: true,
    rows: data.map((record) => {
      const f = record.fields.map((v) => v.trim());
      const at = (index: number) => (index < width ? (f[index] ?? '') : '');
      return {
        line: record.line,
        columns: f.length,
        expectedColumns: width,
        siteCode: at(0),
        deliveredAt: at(1),
        supplier: at(2),
        vehicleNo: at(3),
        massKg: at(4),
        heelMassKg: at(5),
        unitPriceKrw: at(6),
        amountKrw: at(7),
        purityPct: at(8),
        note: at(9),
      };
    }),
  };
}

type RowCheck = { readonly row: DeliveryCsvRow } | { readonly error: string };

function checkRow(raw: RawDeliveryRow, catalog: DeliveryCsvCatalog, nowMs: number): RowCheck {
  if (raw.columns !== raw.expectedColumns) return { error: `열이 헤더와 같은 ${raw.expectedColumns}개여야 합니다 (지금 ${raw.columns}개)` };
  const siteId = catalog.sites.get(raw.siteCode);
  if (siteId === undefined) return { error: `site_code: 없는 사이트입니다 (${raw.siteCode || '빈 값'})` };
  const deliveredAt = parseCsvDateTime(raw.deliveredAt);
  if (deliveredAt === null) return { error: 'delivered_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST)이어야 합니다' };
  if (deliveredAt > nowMs) return { error: 'delivered_at: 미래 시각은 기록할 수 없습니다' };
  if (raw.supplier === '') return { error: 'supplier: 공급사를 입력하세요' };
  if (raw.supplier.length > SUPPLIER_MAX) return { error: `supplier: ${SUPPLIER_MAX}자 이하입니다` };
  if (raw.vehicleNo.length > VEHICLE_NO_MAX) return { error: `vehicle_no: ${VEHICLE_NO_MAX}자 이하입니다` };
  if (raw.note.length > DELIVERY_NOTE_MAX) return { error: `note: ${DELIVERY_NOTE_MAX}자 이하입니다` };
  const mass = optionalNumber(raw.massKg, { label: 'mass_kg', min: 0, max: 100_000, exclusiveMin: true });
  if ('error' in mass) return mass;
  if (mass.value === null) return { error: 'mass_kg: 반입량을 입력하세요' };
  const heel = optionalNumber(raw.heelMassKg, { label: 'heel_mass_kg', min: 0, max: 100_000 });
  if ('error' in heel) return heel;
  const unitPrice = optionalNumber(raw.unitPriceKrw, { label: 'unit_price_krw', min: 0, max: 10_000_000 });
  if ('error' in unitPrice) return unitPrice;
  const amount = optionalNumber(raw.amountKrw, { label: 'amount_krw', min: 0, max: 1e12 });
  if ('error' in amount) return amount;
  const purity = optionalNumber(raw.purityPct, { label: 'purity_pct', min: 0, max: 100, exclusiveMin: true });
  if ('error' in purity) return purity;
  const vehicleNo = raw.vehicleNo === '' ? null : raw.vehicleNo;
  if (catalog.existing.has(deliveryDuplicateKey(siteId, deliveredAt, raw.supplier, vehicleNo))) {
    return { error: '같은 사이트·일시·공급사·차량번호의 반입 기록이 이미 등록되어 있습니다' };
  }
  return {
    row: {
      line: raw.line,
      siteId,
      siteCode: raw.siteCode,
      deliveredAt,
      supplier: raw.supplier,
      vehicleNo,
      massKg: mass.value,
      heelMassKg: heel.value,
      unitPriceKrw: unitPrice.value,
      amountKrw: amount.value,
      purityPct: purity.value,
      note: raw.note === '' ? null : raw.note,
    },
  };
}

export function validateDeliveryRows(rows: readonly RawDeliveryRow[], catalog: DeliveryCsvCatalog, nowMs: number): DeliveryCsvResult {
  const firstLineOf = new Map<string, number>();
  const checked = rows.map((raw) => {
    const check = checkRow(raw, catalog, nowMs);
    if ('error' in check) return { line: raw.line, error: check.error };
    const key = deliveryDuplicateKey(check.row.siteId, check.row.deliveredAt, check.row.supplier, check.row.vehicleNo);
    const seenAt = firstLineOf.get(key);
    if (seenAt !== undefined) return { line: raw.line, error: `${seenAt}행과 사이트·일시·공급사·차량번호가 겹칩니다` };
    firstLineOf.set(key, raw.line);
    return { line: raw.line, row: check.row };
  });
  const errors = checked.flatMap((c) => ('error' in c && c.error !== undefined ? [{ line: c.line, message: c.error }] : []));
  return { rows: checked.flatMap((c) => ('row' in c && c.row ? [c.row] : [])), errors: errors.slice(0, MAX_REPORTED_ERRORS), errorCount: errors.length, dataRows: rows.length };
}

/** 한 번에: 형식 오류면 그 오류만, 아니면 행 검증 */
export function checkDeliveryCsv(text: string, catalog: DeliveryCsvCatalog, nowMs: number): DeliveryCsvResult {
  const read = readDeliveryCsv(text);
  if (!read.ok) return { rows: [], errors: [read.error], errorCount: 1, dataRows: read.dataRows };
  return validateDeliveryRows(read.rows, catalog, nowMs);
}
