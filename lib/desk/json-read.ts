// jsonb 값(unknown)을 좁혀 읽는 도우미. 순수 모듈. 저장 형식이 달라도 화면이 깨지지 않게 모르는 값은 null로 돌려준다.

export type JsonRecord = Readonly<Record<string, unknown>>;

export const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** 숫자 두 개 [x, y]를 객체 배열에서 뽑는다. 둘 중 하나라도 숫자가 아니면 그 점은 뺀다 */
export function xyPoints(value: unknown, xKey: string, yKey: string): (readonly [number, number])[] {
  return asArray(value).flatMap((item) => {
    const row = asRecord(item);
    const x = asNumber(row[xKey]);
    const y = asNumber(row[yKey]);
    return x === null || y === null ? [] : [[x, y] as const];
  });
}
