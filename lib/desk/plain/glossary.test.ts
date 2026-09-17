// 용어집: 항목 규칙과, 화면의 물음표 아이콘이 가리키는 앵커가 실제로 있는지 (죽은 링크 방지).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DETECTORS } from '@/lib/analytics/detectors';
import { GLOSSARY, glossaryTerm } from './glossary';
import { SCREEN_GUIDES } from './guides';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('용어집', () => {
  it('항목마다 앵커 id·용어·쉬운 뜻·예시가 있고 id는 겹치지 않는다', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(20);
    expect(new Set(GLOSSARY.map((term) => term.id)).size).toBe(GLOSSARY.length);
    for (const term of GLOSSARY) {
      expect(term.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(term.term.length).toBeGreaterThan(1);
      expect(term.plain.length).toBeGreaterThan(20);
      expect(term.example.length).toBeGreaterThan(20);
    }
  });

  it('현장 담당자가 만나는 말을 모두 덮는다', () => {
    const required = ['severity', 'confidence', 'effect', 'ci', 'baseline', 'matched', 'operating-segment', 'hold', 'mass-balance', 'self-sufficiency', 'completeness', 'soh', 'soc'];
    expect(required.filter((id) => glossaryTerm(id) === undefined)).toEqual([]);
  });

  it('탐지기 수는 레지스트리에서 뽑아 쓴다 (손으로 적으면 어긋난다)', () => {
    expect(glossaryTerm('detector')?.plain).toContain(`${DETECTORS.length}가지`);
  });

  it('화면의 물음표 아이콘이 가리키는 앵커가 모두 용어집에 있다', () => {
    const files = globSync('{app,components}/**/*.tsx', { cwd: REPO_ROOT });
    expect(files.length).toBeGreaterThan(0);
    const used = files.flatMap((file) => [...readFileSync(`${REPO_ROOT}${file}`, 'utf8').matchAll(/termId="([^"]+)"/g)].map((match) => match[1] ?? ''));
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].filter((id) => glossaryTerm(id) === undefined)).toEqual([]);
  });
});

describe('화면 안내', () => {
  it('화면마다 한 줄이고, 전문 용어 대신 무엇을 보는 곳인지 말한다', () => {
    for (const [key, text] of Object.entries(SCREEN_GUIDES)) {
      expect(text, key).toMatch(/(니다|세요)\.$/);
      expect(text.length, key).toBeLessThanOrEqual(90);
      expect(text.includes('\n'), key).toBe(false);
    }
  });
});
