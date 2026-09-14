import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAD_MASK, INFO_MASK, isGood, isGoodWithTrustedClock, QUALITY } from './quality';

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

/** measurement 마이그레이션 주석의 "1 DEVICE_BAD, 2 HARD_RANGE, ..." 목록을 읽는다. */
function readQualityBitsFromMigration(): Record<string, number> {
  const file = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith('_om-ingest-measurement.sql'));
  if (!file) throw new Error('om-ingest-measurement 마이그레이션을 찾지 못했습니다');

  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
  const line = sql.split('\n').find((text) => /^--\s+1 DEVICE_BAD/.test(text));
  if (!line) throw new Error('quality 비트 주석을 찾지 못했습니다');

  return Object.fromEntries([...line.matchAll(/(\d+) ([A-Z_]+)/g)].map(([, bit, name]) => [name, Number(bit)]));
}

describe('QUALITY', () => {
  it('비트는 서로 겹치지 않는 2의 거듭제곱이고 smallint 범위 안이다', () => {
    const bits = Object.values(QUALITY);

    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(Number.isInteger(Math.log2(bit))).toBe(true);
      expect(bit).toBeLessThanOrEqual(16_384);
    }
  });

  it('measurement 마이그레이션 주석과 값이 같다', () => {
    expect(readQualityBitsFromMigration()).toEqual({ ...QUALITY });
  });

  it('모든 비트는 BAD 또는 INFO 중 정확히 한쪽에 속한다', () => {
    const all = Object.values(QUALITY).reduce((mask, bit) => mask | bit, 0);

    expect(BAD_MASK & INFO_MASK).toBe(0);
    expect(BAD_MASK | INFO_MASK).toBe(all);
    expect(BAD_MASK).toBe(QUALITY.DEVICE_BAD | QUALITY.HARD_RANGE | QUALITY.SPIKE | QUALITY.FLATLINE);
  });
});

describe('isGood / isGoodWithTrustedClock', () => {
  it.each([
    ['0', 0, true, true],
    ['LATE만', QUALITY.LATE, true, true],
    ['REPROCESSED | LATE', QUALITY.REPROCESSED | QUALITY.LATE, true, true],
    ['CLOCK_SUSPECT', QUALITY.CLOCK_SUSPECT, true, false],
    ['DEVICE_BAD', QUALITY.DEVICE_BAD, false, false],
    ['HARD_RANGE | LATE', QUALITY.HARD_RANGE | QUALITY.LATE, false, false],
    ['SPIKE', QUALITY.SPIKE, false, false],
    ['FLATLINE | CLOCK_SUSPECT', QUALITY.FLATLINE | QUALITY.CLOCK_SUSPECT, false, false],
  ])('%s → good=%s, 시계 신뢰 good=%s', (_label, quality, good, trusted) => {
    expect(isGood(quality)).toBe(good);
    expect(isGoodWithTrustedClock(quality)).toBe(trusted);
  });
});
