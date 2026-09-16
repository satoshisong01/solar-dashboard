// 외부 수소 반입 기록 직접 입력 폼 검증. 서버 전용 (zod). CSV 쪽 규칙(lib/h2delivery/delivery-csv.ts)과 같은 한계값을 쓴다.
import * as z from 'zod';
import type { FormValues } from './action-state';
import { kstDateTime, optionalText, parseWith, type ParseResult } from './desk';
import { idField, optionalDecimalField, pickFields, SMALLINT_MAX } from './fields';
import { DELIVERY_NOTE_MAX, SUPPLIER_MAX, VEHICLE_NO_MAX } from './limits';

export interface DeliveryFormInput {
  readonly siteId: number;
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

const FIELDS = ['siteId', 'deliveredAt', 'supplier', 'vehicleNo', 'massKg', 'heelMassKg', 'unitPriceKrw', 'amountKrw', 'purityPct', 'note'] as const;

const bounded = (label: string, max: number) => optionalDecimalField(label).refine((v) => v === null || (v >= 0 && v <= max), `${label}은(는) 0 이상 ${max.toLocaleString('ko-KR')} 이하여야 합니다`);

export function parseDeliveryForm(values: FormValues, input: Readonly<{ nowMs: number }>): ParseResult<DeliveryFormInput> {
  const schema = z.object({
    siteId: idField('사이트를 고르세요', SMALLINT_MAX),
    deliveredAt: kstDateTime('하역 일시를 입력하세요').refine((ms) => ms <= input.nowMs, '미래 시각은 기록할 수 없습니다'),
    supplier: z.string().trim().min(1, '공급사를 입력하세요').max(SUPPLIER_MAX, `공급사는 ${SUPPLIER_MAX}자 이하입니다`),
    vehicleNo: optionalText(VEHICLE_NO_MAX, '차량·전표번호'),
    massKg: bounded('반입량', 100_000).refine((v) => v !== null && v > 0, '반입량을 0보다 크게 입력하세요'),
    heelMassKg: bounded('반환 잔량', 100_000),
    unitPriceKrw: bounded('단가', 10_000_000),
    amountKrw: bounded('금액', 1e12),
    purityPct: optionalDecimalField('순도').refine((v) => v === null || (v > 0 && v <= 100), '순도는 0 초과 100 이하여야 합니다'),
    note: optionalText(DELIVERY_NOTE_MAX, '메모'),
  });
  const parsed = parseWith(schema, pickFields(values, FIELDS));
  if (!parsed.ok) return parsed;
  return { ok: true, input: { ...parsed.input, massKg: parsed.input.massKg as number } };
}
