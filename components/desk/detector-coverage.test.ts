// 탐지기를 더하면 함께 있어야 할 것들: 근거 화면 · 쉬운 말 문장 · 플레이북.
// 가평 3종을 더하면서 근거 화면이 빠져 사용자에게 "아직 보여 주지 않습니다"가 뜨던 사고를 막는 게이트다.
// 화면 검사는 실제로 서버 렌더링해서 본다 — 근거 형식(kind)만 세면 case가 없어 default로 떨어지는 것을 못 잡는다.
// JSX 없이 createElement로 부른다 (unit 프로젝트는 *.test.ts만 실행한다).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DETECTORS } from '@/lib/analytics/detectors';
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import { PLAIN_HEADLINE_DETECTORS } from '@/lib/desk/plain/headline';
import { plainCases } from '@/lib/desk/plain/test-fixtures';
import { EvidenceCanvas, UNSUPPORTED_EVIDENCE_NOTE } from './evidence-canvas';

const DETECTOR_IDS = DETECTORS.map((detector) => detector.id);
const CASES = plainCases();

const renderCanvas = (detectorId: string): string => {
  const found = CASES.find((item) => item.detectorId === detectorId);
  if (!found) throw new Error(`근거 픽스처가 없습니다: ${detectorId}`);
  return renderToStaticMarkup(
    createElement(EvidenceCanvas, { evidence: found.evidence, chargeTimeText: null, assetLabel: '설비 1', siteCode: 'SIM-A', peerCodes: new Map<number, string>() }),
  );
};

describe('탐지기를 더하면 따라와야 할 것', () => {
  it('근거 픽스처가 탐지기 전체를 덮는다 (이 목록이 아래 화면 검사의 입력이다)', () => {
    expect(CASES.map((item) => item.detectorId).sort()).toEqual([...DETECTOR_IDS].sort());
  });

  it.each(DETECTOR_IDS)('%s: 근거 화면이 있다 (EvidenceCanvas가 default로 떨어지지 않는다)', (detectorId) => {
    const html = renderCanvas(detectorId);
    expect(html).not.toContain(UNSUPPORTED_EVIDENCE_NOTE);
    expect(html.length).toBeGreaterThan(0);
  });

  it.each(DETECTOR_IDS)('%s: 쉬운 말 한 줄 요약 규칙이 있다', (detectorId) => {
    expect(PLAIN_HEADLINE_DETECTORS).toContain(detectorId);
  });

  it.each(DETECTORS.map((detector) => [detector.id, detector.failureMode] as const))('%s: 고장모드 %s의 플레이북이 있다', (_, failureMode) => {
    expect(Object.keys(PLAYBOOKS)).toContain(failureMode);
  });
});

// 용어집이 '14가지'라고 적어 둔 채 탐지기가 17종이 된 일을 막는다: 화면 글자에 개수를 숫자로 쓰지 말고 레지스트리에서 뽑는다.
const SOURCE_DIRS = ['app', 'components', 'lib'] as const;
const HARDCODED_COUNT = /\d+\s*(?:종|가지)/g;
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

const sourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

describe('화면 글자의 개수', () => {
  it('탐지기 수 같은 개수를 숫자로 적어 두지 않는다 (레지스트리 길이를 넣는다)', () => {
    const found = SOURCE_DIRS.flatMap((dir) =>
      sourceFiles(dir).flatMap((file) => {
        const source = stripComments(readFileSync(file, 'utf8'));
        return [...source.matchAll(HARDCODED_COUNT)].map((match) => `${file}: ${match[0]}`);
      }),
    );
    expect(found, '주석이 아닌 코드에 남은 개수 표기 — DETECTORS.length 등으로 바꾸세요').toEqual([]);
  });
});
