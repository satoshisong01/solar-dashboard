// 근거 스냅샷을 zod로 너그럽게 읽는 조각 (순수). 값이 없거나 타입이 틀리면 null·0·false·빈 배열로 바꿔 파싱이 던지지 않게 한다.
import * as z from 'zod';

export const num = z.number().nullable().catch(null);
export const str = z.string().nullable().catch(null);
export const count = z.number().int().nonnegative().catch(0);
export const bool = z.boolean().catch(false);

/** 배열: 배열이 아니면 빈 배열, 항목 형식이 깨졌으면 그 항목만 뺀다 */
export function listOf<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items): z.output<T>[] =>
      items.flatMap((raw) => {
        const parsed = item.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}
