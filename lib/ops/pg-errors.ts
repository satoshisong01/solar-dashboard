// pg(DatabaseError) 오류에서 SQLSTATE·제약 이름을 안전하게 꺼낸다. 'server-only'를 넣지 않는다 (테스트에서도 쓴다).

interface PgErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const fieldsOf = (error: unknown): PgErrorFields => (typeof error === 'object' && error !== null ? (error as PgErrorFields) : {});

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export function pgErrorCode(error: unknown): string | null {
  const { code } = fieldsOf(error);
  return typeof code === 'string' ? code : null;
}

export function pgConstraint(error: unknown): string | null {
  const { constraint } = fieldsOf(error);
  return typeof constraint === 'string' ? constraint : null;
}
