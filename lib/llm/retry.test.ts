import { describe, expect, it } from 'vitest';
import { canReuseStored, isTransientFailure, TRANSIENT_RETRY_MS, type StoredOutcome } from './retry';
import type { LlmFailureReason } from './types';

const NOW = 1_800_000_000_000;
const stored = (reason: LlmFailureReason | null, ageMs: number, source: 'template' | 'llm' = 'template'): StoredOutcome => ({ source, reason, createdAtMs: NOW - ageMs });

describe('isTransientFailure', () => {
  it.each<LlmFailureReason>(['timeout', 'rate_limited', 'server_error', 'transport_error'])('제공자 쪽 사정은 일시적이다: %s', (reason) => {
    expect(isTransientFailure(reason)).toBe(true);
  });

  it.each<LlmFailureReason>(['no_key', 'disabled', 'no_evidence', 'bad_response', 'rejected'])('다시 불러도 같은 것은 일시적이 아니다: %s', (reason) => {
    expect(isTransientFailure(reason)).toBe(false);
  });

  it('사유가 없으면(성공) 일시적이 아니다', () => {
    expect(isTransientFailure(null)).toBe(false);
  });
});

describe('canReuseStored', () => {
  it('채택한 문장은 오래돼도 그대로 쓴다', () => {
    expect(canReuseStored(stored(null, TRANSIENT_RETRY_MS * 100, 'llm'), NOW)).toBe(true);
  });

  it('검증에 걸려 되돌아간 틀 문장은 그대로 쓴다 (다시 불러도 같다)', () => {
    expect(canReuseStored(stored('rejected', TRANSIENT_RETRY_MS * 100), NOW)).toBe(true);
    expect(canReuseStored(stored('bad_response', TRANSIENT_RETRY_MS * 100), NOW)).toBe(true);
  });

  it('타임아웃으로 되돌아간 틀 문장은 잠시만 쓰고 기간이 지나면 버린다', () => {
    expect(canReuseStored(stored('timeout', TRANSIENT_RETRY_MS - 1), NOW)).toBe(true);
    expect(canReuseStored(stored('timeout', TRANSIENT_RETRY_MS), NOW)).toBe(false);
  });

  it('429·5xx·네트워크 오류도 같은 기간을 쓴다', () => {
    for (const reason of ['rate_limited', 'server_error', 'transport_error'] as const) {
      expect(canReuseStored(stored(reason, TRANSIENT_RETRY_MS + 1), NOW)).toBe(false);
    }
  });
});
