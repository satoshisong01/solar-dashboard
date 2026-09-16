// Pretendard Variable을 unicode-range로 나눈 dynamic subset(woff2 92개)으로 app/fonts에 가져온다.
//   npm run fonts:sync
// 한 벌(2MB)을 통째로 받던 것을 구간별로 나눠, 첫 화면이 실제로 쓰는 구간만 받게 한다.
// 글리프를 버리지 않으므로 희귀 한글도 그대로 나온다 (그 구간 파일을 그때 받는다).
//
// 만들어지는 것
//   app/fonts/pretendard/PretendardVariable.subset.*.woff2  (92개, 업스트림 그대로)
//   app/fonts/pretendard.css                                 (미리 받는 구간을 뺀 @font-face)
// 미리 받는 구간(PRELOADED_SUBSET)은 app/layout.tsx의 next/font/local이 선언한다.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.3.9';
/** 라틴·기호·숫자와 가장 흔한 한글 음절이 든 구간. next/font/local이 preload한다 */
const PRELOADED_SUBSET = 91;

const FONT_DIR = join(process.cwd(), 'app', 'fonts');
const SUBSET_DIR = join(FONT_DIR, 'pretendard');
const CSS_PATH = join(FONT_DIR, 'pretendard.css');

const HEADER = `/* 이 파일은 npm run fonts:sync가 만듭니다. 직접 고치지 마세요. (pretendard@${VERSION})
   @font-face와 unicode-range는 업스트림 dynamic subset CSS 그대로이고,
   경로와 format()만 바꿨습니다. [${PRELOADED_SUBSET}] 구간은 app/layout.tsx가 선언합니다. */\n`;

/** 업스트림 CSS에서 구간 하나의 @font-face 블록 (앞의 /* [n] *​/ 주석 포함) */
const BLOCK = /\/\* \[(\d+)\] \*\/\s*@font-face \{[^}]*\}/g;

function download(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pretendard-'));
  // 인자를 전부 상대 경로로 둔다. 절대 경로를 주면 tar 구현에 따라 'C:\'의 콜론을 원격 호스트로 읽고 죽는다.
  const tgz = execFileSync('npm', ['pack', `pretendard@${VERSION}`], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').at(-1)?.trim();
  if (!tgz) throw new Error('npm pack이 파일 이름을 내놓지 않았습니다');
  execFileSync('tar', ['-xzf', tgz, 'package/dist/web/variable'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  return join(dir, 'package', 'dist', 'web', 'variable');
}

function buildCss(upstream: string): string {
  const blocks = [...upstream.matchAll(BLOCK)]
    .filter(([, index]) => Number(index) !== PRELOADED_SUBSET)
    .map(([block]) =>
      block
        .replace(/url\(\.\/woff2-dynamic-subset\/([^)]+)\)/, "url('./pretendard/$1')")
        // 'woff2-variations'는 옛 초안 표기라 모르는 값으로 보고 건너뛰는 브라우저가 있다.
        .replace("format('woff2-variations')", "format('woff2')"),
    );
  if (blocks.length === 0) throw new Error('업스트림 CSS에서 @font-face를 찾지 못했습니다');
  return `${HEADER}\n${blocks.join('\n\n')}\n`;
}

function main(): void {
  const source = download();
  const upstream = readFileSync(join(source, 'pretendardvariable-dynamic-subset.css'), 'utf8');

  rmSync(SUBSET_DIR, { recursive: true, force: true });
  mkdirSync(SUBSET_DIR, { recursive: true });
  cpSync(join(source, 'woff2-dynamic-subset'), SUBSET_DIR, { recursive: true });
  writeFileSync(CSS_PATH, buildCss(upstream));

  const files = readdirSync(SUBSET_DIR);
  console.log(`[fonts] pretendard@${VERSION} 구간 ${files.length}개를 app/fonts/pretendard에 넣었습니다 (preload: [${PRELOADED_SUBSET}]).`);
}

main();
