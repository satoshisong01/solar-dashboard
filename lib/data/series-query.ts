// /api/series 쿼리 파라미터 검증 (zod). 서버에서만 쓴다: 클라이언트는 series-types.ts를 쓴다.
import * as z from 'zod';
import { INT4_MAX, SERIES_LIMITS, type SeriesQuery } from './series-types';

const pointIdsSchema = z
  .string({ error: 'pointIds가 필요합니다' })
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^[1-9]\d{0,9}$/, 'pointIds는 양의 정수여야 합니다')
          .transform(Number)
          .refine((id) => id <= INT4_MAX, 'pointIds는 양의 정수여야 합니다'),
      )
      .min(1, 'pointIds가 필요합니다'),
  )
  .transform((ids) => [...new Set(ids)])
  .refine((ids) => ids.length <= SERIES_LIMITS.maxPointIds, {
    error: `pointIds는 최대 ${SERIES_LIMITS.maxPointIds}개입니다`,
  });

const seriesQuerySchema = z
  .object({
    pointIds: pointIdsSchema,
    from: z.iso.datetime({ offset: true, error: 'from은 ISO 8601 시각이어야 합니다' }).transform(Date.parse),
    to: z.iso.datetime({ offset: true, error: 'to는 ISO 8601 시각이어야 합니다' }).transform(Date.parse),
    maxPoints: z.coerce
      .number({ error: 'maxPoints는 정수여야 합니다' })
      .int('maxPoints는 정수여야 합니다')
      .min(SERIES_LIMITS.minMaxPoints, `maxPoints는 ${SERIES_LIMITS.minMaxPoints} 이상이어야 합니다`)
      .max(SERIES_LIMITS.maxMaxPoints, `maxPoints는 ${SERIES_LIMITS.maxMaxPoints} 이하여야 합니다`)
      .default(SERIES_LIMITS.defaultMaxPoints),
  })
  .refine((query) => query.from < query.to, { path: ['to'], error: 'to는 from보다 뒤여야 합니다' })
  .refine((query) => query.to - query.from <= SERIES_LIMITS.maxSpanMs, {
    path: ['to'],
    error: '조회 기간은 366일 이하여야 합니다',
  });

export type ParseResult<T> = { readonly success: true; readonly data: T } | { readonly success: false; readonly error: string };

/** URL 쿼리 → SeriesQuery. pointIds는 쉼표 구분(반복 파라미터도 허용), 빈 값은 없는 것으로 본다 */
export function parseSeriesQuery(params: URLSearchParams): ParseResult<SeriesQuery> {
  const pointIds = params.getAll('pointIds').join(',');
  const optional = (key: string) => {
    const value = params.get(key);
    return value === null || value === '' ? undefined : value;
  };
  const result = seriesQuerySchema.safeParse({
    pointIds: pointIds === '' ? undefined : pointIds,
    from: optional('from'),
    to: optional('to'),
    maxPoints: optional('maxPoints'),
  });
  if (!result.success) {
    return { success: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
  }
  const { pointIds: ids, from, to, maxPoints } = result.data;
  return { success: true, data: { pointIds: ids, fromMs: from, toMs: to, maxPoints } };
}
