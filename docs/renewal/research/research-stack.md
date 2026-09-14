# 기술 스택 검증 리포트: 수소·태양광 O&M 인텔리전스 콘솔

작성 기준일: 2026-09-14. 대상은 `c:/Users/jungm/Desktop/projects/simple/solar-dashboard`이며 코드는 수정하지 않았습니다.
검증 방법:
- `package.json`, `node_modules/*/package.json`, Next 내부 소스를 직접 읽었습니다.
- `npm view`로 npm 레지스트리의 최신 버전, dist-tag, peerDeps를 확인했습니다.
- `npm audit`는 lockfile만 읽는 방식으로 돌렸습니다.
- 스크래치패드에서 두 가지를 직접 실험했습니다. esbuild로 차트 라이브러리 번들 크기를 쟀고, ECharts와 `server-only`의 동작을 확인했습니다.
- Next 16.3.5 tarball에 들어 있는 공식 문서(`dist/docs`)를 풀어서 읽었습니다.
- 웹 문서로 교차 확인했습니다.

---

## 0. 결론 요약

| 항목 | 권고 | 확신도 |
|---|---|---|
| Next.js | **16.1.1 → 16.3.5로 즉시 업그레이드.** 16.1.1에는 Proxy 우회, Server Action CSRF 우회, RCE 계열 advisory가 걸려 있습니다(critical 1건 포함). | high |
| 콘솔 구조 | `app/(auth)/login`, `app/(console)/...`로 루트 레이아웃 1개를 둡니다. RSC가 DAL(`lib/data`)을 직접 조회하고, Route Handler는 외부 수신, 크론, auth, 차트 줌 재조회에만 씁니다. `cacheComponents`는 당분간 끕니다. | high |
| 로그인 | **Better Auth 1.7.x.** 이메일+비밀번호, `disableSignUp`, admin 플러그인, DB 세션, DB 기반 rate limit을 씁니다. 보호는 `proxy.ts`(낙관적 쿠키 검사)와 DAL `requireAdmin()`(실제 검사) 두 겹으로 합니다. Auth.js v5는 제외합니다. | medium-high |
| 차트 | **Apache ECharts 6.1**(트리셰이킹, 직접 만든 얇은 래퍼)에 서버측 `date_bin` 다운샘플링을 붙입니다. | high |
| 지도 | Kakao는 유지하되 `react-kakao-maps-sdk` 1.2.2로 선언형 전환합니다. `leaflet`, `react-leaflet`, `@types/leaflet`은 삭제합니다(미사용 확인). | medium-high |
| DB | `pg` 8.23 + **Kysely 0.29**(쿼리) + **순수 SQL 마이그레이션(dbmate)** + `kysely-codegen`(타입). 입력 검증은 **zod 4.6** 직접 의존성으로 추가합니다. | high |
| 아이콘 | Font Awesome CDN 대신 **lucide-react 1.45**. | high |
| 테스트 | Vitest 5(분석 엔진 순수 함수는 unit, SQL은 integration) + Playwright 1.63(`next build && next start` 대상). | high |
| 로컬 개발 | docker compose(Postgres는 **RDS와 같은 메이저**) + `dbmate` + `tsx --env-file`로 시드와 시뮬레이터를 돌립니다. | high |
| TypeScript | 5.9 유지. TS 7은 typescript-eslint가 지원하지 않습니다(`<6.1.0`). | high |

---

## 1. 레포 실측 결과

### 1.1 설치 버전과 최신 버전

| 패키지 | 설치(node_modules) | 최신(npm latest) | 비고 |
|---|---|---|---|
| next | 16.1.1 | **16.3.5** (2026-09-11) | 16.1.1은 advisory 다수 |
| react / react-dom | 19.2.3 | 19.3.0 | |
| chart.js / react-chartjs-2 | 4.5.1 / 5.3.1 | 동일 | |
| leaflet / react-leaflet | 1.9.4 / 5.0.0 | 동일 | **import하는 곳 0건** |
| pg | 8.16.3 | 8.23.0 | |
| typescript | 5.9.3 | 7.0.2 | typescript-eslint 8.70은 `typescript <6.1.0`만 지원 |
| tailwindcss | 4.1.18 | 4.3.3 | |
| babel-plugin-react-compiler | 1.0.0 | 1.0.0 | |
| eslint / eslint-config-next | 9.39.2 / 16.1.1 | 10.10.0 / 16.3.5 | |
| zod | 4.3.5 (**전이 devDep**, 직접 의존성 아님) | 4.6.5 | 직접 추가 필요 |
| Node (로컬) | v22.20.0 | | Next 16 최소 20.9, Vitest 5는 ^22.12 |
| Docker / Compose | 27.3.1 / v2.30.3 | | `compose up --wait` 사용 가능 |

`package.json`에 **`"solar-dashboard": "file:"` 자기참조 의존성**이 있습니다. 실수로 들어간 것으로 보이니 제거 대상입니다.

### 1.2 `node_modules/next/dist/docs/`
- **설치된 16.1.1에는 이 폴더가 없습니다.** Next 16.2부터 문서가 번들로 들어갑니다(업그레이드 가이드: "On Next.js 16.2 and later ... bundled docs in `node_modules/next/dist/docs/`").
- 대신 `next@16.3.5` tarball을 받아 `dist/docs` 456개 파일 중 필요한 문서를 읽었습니다: version-16 업그레이드, authentication, data-security, proxy, route-handlers, server-actions, cacheComponents, testing.
- 16.3.x의 `next dev`는 AI 에이전트를 감지하면 **`AGENTS.md`와 `CLAUDE.md`(`@AGENTS.md`)에 관리 블록을 자동으로 씁니다**(`dist/server/lib/generate-agent-files.js`). 업그레이드 뒤 첫 커밋에 이 파일이 따라 들어갈 수 있습니다.

### 1.3 `npm audit` (lockfile 기준)
14건입니다: critical 1, high 9, moderate 3, low 1. 핵심은 `next` 9.3.4 ~ 16.3.2 범위이고, **16.3.5에서 해결**됩니다. 콘솔 설계와 직접 관련된 항목은 다음과 같습니다.
- Middleware/Proxy 우회 4건: GHSA-267c-6grr-h53f, GHSA-26hh-7cqf-hhc6, GHSA-492v-c6pp-mqqv, GHSA-6gpp-xcg3-4w24. **Proxy만으로 인증하면 뚫린다는 뜻입니다.**
- Server Actions CSRF 우회(null origin): GHSA-mq59-m269-xvcx
- Windows 호스팅 서버 비인증 RCE: GHSA-p293-qw3h-jr36. 로컬이 Windows인 점을 감안하세요.
- Server Function 엔드포인트 비인증 노출: GHSA-955p-x3mx-jcvp

### 1.4 설치된 16.1.1 내부 소스로 직접 확인한 Next 16 동작

| 확인 항목 | 결과 | 근거 |
|---|---|---|
| middleware → proxy 이름 변경 | **예.** `PROXY_FILENAME='proxy'`. 두 파일이 같이 있으면 빌드 에러, `middleware`만 있으면 deprecation 경고 | `next/dist/lib/constants.js`, `build/index.js:574-611` |
| proxy 런타임 | **Node.js 고정.** `export const runtime`를 쓰면 프로덕션 빌드 에러(E394) | `build/analysis/get-page-static-info.js:552` |
| `params` / `searchParams` | **Promise.** 동기 접근은 16에서 완전히 제거. 전역 `PageProps<'/x/[id]'>`, `LayoutProps`, `RouteContext` 타입 생성(typegen) | `esm/server/lib/router-utils/typegen.js` |
| `cookies()` / `headers()` | async 전용 | `server/request/*.js` |
| 캐시 API | `cacheLife`, `cacheTag` 안정화(`unstable_` 없음). `updateTag`, `refresh`가 `next/cache`에서 export됨. `revalidateTag(tag, profile)`는 인자 2개 필수 | `next/cache.d.ts`, 업그레이드 문서 |
| `cacheComponents` | 최상위 옵션, 기본 `false`. PPR은 이 옵션으로 흡수 | `server/config-shared.d.ts:1038,1140` |
| `unauthorized()` / `forbidden()` | `experimental.authInterrupts`(문서상 **canary**) → 사용하지 않음 | 문서 `authInterrupts.md` |
| Turbopack | dev와 build 모두 기본. `next dev`는 `.next/dev`에 따로 출력하고, 같은 프로젝트에서 dev를 두 번 띄우는 것은 lockfile로 막음 | 업그레이드 문서 |
| `next lint` | 제거됨. 현재 `"lint": "eslint"`는 이미 호환 | |
| Route Handler | GET도 기본은 캐시하지 않음. 같은 세그먼트에 `page`와 `route`를 둘 수 없음. **"Route Handler는 공개 HTTP 엔드포인트"** | `route-handlers.md`, `backend-for-frontend.md` |
| Server Actions | 클라이언트는 **한 번에 하나씩 순차 dispatch**함. 설계 목적은 mutation이고, 페이지 수준 인증이 액션에 전파되지 않음. 액션 안에서 다시 검증해야 함 | `server-actions.md`, `data-security.md` |
| Proxy matcher 주의 | Server Function은 "해당 페이지 경로로 가는 POST"라서, matcher로 경로를 빼면 **그 경로의 액션도 Proxy를 건너뜀** | `proxy.md:249-251` |
| TypeScript 7 | 16.3에는 `experimental.useTypeScriptCli`가 있음(기본 on, 프로젝트 로컬 `tsc` 사용). 다만 ESLint 쪽이 막힘 | `useTypeScriptCli.md` |

---

## 2. 권고 1: Next 16 App Router 관리자 콘솔 구조

### 2.1 라우트 트리 (루트 레이아웃은 하나)
루트 레이아웃이 여러 개면 그룹 사이를 이동할 때 풀 리로드가 일어납니다(route-groups 문서). 그래서 **`app/layout.tsx` 하나만 루트로 두고** 그룹 레이아웃은 그 아래에 둡니다.

```
proxy.ts                                  # 낙관적 세션 쿠키 검사만 (DB 조회 없음)
app/
  layout.tsx                              # html/body, 폰트, globals.css (FA CDN 제거)
  (auth)/login/page.tsx                   # 공개. useActionState + Server Action
  (console)/layout.tsx                    # 사이드바/탑바 셸 (표시용 user는 DAL에서)
  (console)/page.tsx                      # 플릿 개요: 사이트 상태, 미확인 finding, 수익 요약 위젯
  (console)/sites/page.tsx
  (console)/sites/[siteId]/page.tsx       # 사이트 상세: 설비 트리, KPI, 최근 finding
  (console)/sites/[siteId]/assets/[assetId]/page.tsx   # 부품 단위 시계열·조건부 비교
  (console)/findings/page.tsx             # 이상/열화 탐지 결과 (확인/조치 Server Action)
  (console)/reports/page.tsx
  (console)/reports/[reportId]/page.tsx   # 코칭 리포트 (템플릿 렌더)
  (console)/metrics/page.tsx              # 메트릭 레지스트리 (데이터 계약 등록)
  (console)/settings/admins/page.tsx
  api/auth/[...all]/route.ts              # Better Auth 핸들러
  api/ingest/route.ts                     # 사이트 게이트웨이 수신 (사이트별 API 키/HMAC, Proxy matcher 제외)
  api/cron/analyze/route.ts               # Vercel Cron (CRON_SECRET 검사)
  api/cron/retention/route.ts
  api/series/route.ts                     # 차트 줌/팬 시 고해상도 재조회 (GET, 세션 검사)
lib/
  db/pool.ts, db/kysely.ts, db/types.gen.ts
  auth/auth.ts, auth/dal.ts
  data/*.ts                               # 'server-only' 조회 함수 (DTO 반환, 내부에서 requireAdmin)
  analytics/*.ts                          # 순수 함수, I/O 없음 → Vitest unit
  reports/*.ts                            # 템플릿 렌더 + NarrativeGenerator 인터페이스(LLM 확장 지점)
  ingest/ingestBatch.ts                   # Route Handler와 시뮬레이터 스크립트가 공유
components/charts/EChart.tsx ('use client')
db/migrations/*.sql
scripts/seed.ts, scripts/simulate.ts, scripts/run-analysis.ts
```

### 2.2 서버 컴포넌트에서 DB 직접 조회 vs Route Handler
- **기본은 RSC → DAL(`lib/data`) 직접 조회입니다.** Next 문서 `backend-for-frontend.md:879`는 "Fetch data in Server Components directly from its source, not via Route Handlers"라고 적고 있고, 이유로 추가 HTTP 왕복과 빌드 실패를 듭니다. 현재 코드처럼 클라이언트가 `/api/solar`를 fetch하는 방식은 폐기합니다.
- 같은 요청 안에서 중복 조회를 막으려면 `React.cache`로 감쌉니다(fetching-data 문서의 "Reusing data with React.cache").
- **Route Handler는 네 가지 용도로만 씁니다.**
  1. 외부 기계 클라이언트의 수신(`/api/ingest`)
  2. Vercel Cron
  3. auth 핸들러
  4. 브라우저 인터랙션 중 서버 렌더로 해결되지 않는 **읽기**(차트 줌 재조회)
- 4번에 Server Action을 쓰지 않는 이유가 있습니다. 액션은 순차 dispatch되는 POST라서 줌/팬처럼 연속으로 들어오는 읽기에 맞지 않습니다.
- **Mutation**(finding 확인, 조치 기록, 리포트 생성, 메트릭 등록)은 Server Action으로 합니다. 순서는 `requireAdmin()` → zod 검증 → DAL → `refresh()` 또는 `revalidatePath()`입니다.

### 2.3 클라이언트 폴링 최소화
1. **브라우저 시뮬레이터와 날씨 폴링을 전부 제거합니다**(`app/page.tsx`의 `setInterval` 3개). 탭이 열려 있을 때만 데이터가 생기고, 탭을 여러 개 열면 INSERT가 중복됩니다.
2. 무거운 분석은 **배치로 미리 계산**합니다(크론 또는 스크립트 → `findings`, 일별 롤업 테이블). 페이지는 결과 테이블만 읽습니다.
3. 준실시간이 필요한 개요 화면 하나에만 아래처럼 작은 컴포넌트를 둡니다. 탭이 보일 때만 N분마다 RSC를 새로고침합니다. SWR이나 React Query는 초기엔 필요 없습니다.

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
```

### 2.4 `cacheComponents`는 꺼 둡니다 (확신도 medium)
- 콘솔 전 화면이 세션 의존이라 모두 동적입니다. 켜면 세션을 읽는 모든 곳에 `<Suspense>`와 `use cache: private` 규칙이 붙습니다(authentication-with-cache-components 문서). 16.3은 instant navigation 검증 경고도 냅니다.
- 소규모 팀에는 이득보다 복잡도가 큽니다. 나중에 불변 리포트 페이지 같은 곳에서만 도입을 검토하세요.
- 선택 사항: `typedRoutes: true`(16에서 안정화)는 콘솔 내부 링크 오타 방지에 유용합니다.

---

## 3. 권고 2: 관리자 로그인

### 3.1 비교

| 기준 | Auth.js (next-auth v5) | Better Auth 1.7.4 | 직접 구현 (jose + argon2 + users 테이블) |
|---|---|---|---|
| 상태 | **여전히 `5.0.0-beta.32`**(npm dist-tag `beta`, `latest`는 4.24.15). 2025-09에 Better Auth 팀으로 이관됐고 사실상 유지보수 모드. 신규 프로젝트에는 Better Auth를 권장 | 활발히 개발 중. Next 16을 peer로 지원(`^14 \|\| ^15 \|\| ^16`). Next 공식 문서 Auth Libraries 목록에 있음 | 의존성 최소. Next 문서에 jose 예제 있음 |
| 이메일+비번 | Credentials provider는 기능이 제한적이고 DB 세션과 조합이 불편 | 기본 제공. `disableSignUp`, 최소 길이 설정 가능 | 직접 작성 |
| 세션 폐기 | JWT 기본 | **DB 세션**(폐기 가능), 선택적 cookie cache | 직접 sessions 테이블 |
| Rate limit | 없음 | 기본 제공. `/sign-in/email`은 10초 3회. **서버리스에서는 `storage: 'database'` 필수**(메모리 저장소는 인스턴스 사이에 공유 안 됨) | 직접 |
| 2FA / 역할 | 직접 | twoFactor, admin 플러그인(role, ban, 세션 폐기) | 직접 |
| DB 연동 | 어댑터 | **pg `Pool`을 그대로 받음. 내부적으로 Kysely 사용** → 권고 스택과 일치 | pg/Kysely |
| 해시 | - | scrypt(순수 JS, 네이티브 모듈 없음 → Windows와 Vercel 모두 무난) | `@node-rs/argon2`(prebuilt napi. Next 기본 `serverExternalPackages` 목록에 포함된 것 확인) |
| 리스크 | 신규 기능 없음 | **advisory가 잦음.** 다만 최근 건은 대부분 sso, scim, oauth-provider, stripe 플러그인이고, 코어는 magic-link/email-OTP의 pre-account hijacking이었음. 이 콘솔은 해당 플러그인을 쓰지 않음 | 보안 코드를 직접 작성하고 테스트해야 함 |

### 3.2 권고: Better Auth (최소 구성)
관리자가 소수이고 가입과 OAuth가 필요 없으면 직접 구현도 가능합니다. 다만 다음 세 가지를 직접 쓰는 비용과 실수 위험이 더 큽니다: rate limit, DB 세션 폐기, 2FA 확장. Next 문서도 라이브러리 사용을 권장합니다. 운영 조건은 두 가지입니다.
- 쓰지 않는 플러그인은 설치하지 않습니다.
- 버전을 고정하고 GitHub Security Advisory를 구독합니다.

```ts
// lib/auth/auth.ts
import 'server-only';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { admin } from 'better-auth/plugins';
import { pool } from '@/lib/db/pool';

export const auth = betterAuth({
  database: pool, // pg Pool 공유
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
  session: { expiresIn: 60 * 60 * 8, updateAge: 60 * 60 },
  rateLimit: { enabled: true, storage: 'database' },
  // 테이블명 user는 PG 예약어라 SQL에서 인용이 필요함 → auth_ 접두 권장
  user: { modelName: 'auth_user' },
  session: { modelName: 'auth_session' },   // (실제 코드에서는 session 키를 하나로 병합)
  account: { modelName: 'auth_account' },
  verification: { modelName: 'auth_verification' },
  plugins: [admin(), nextCookies()], // nextCookies는 마지막
});
```

- 스키마: `npx auth@latest generate`로 SQL을 뽑아 **`db/migrations`에 복사**합니다. RDS에 `auth migrate`를 직접 돌리지 말고 마이그레이션 원천을 하나로 유지하세요.
- 기본 컬럼명은 camelCase(`emailVerified`, `createdAt`)입니다. 손으로 SQL을 쓸 때 인용이 필요합니다.
- 첫 관리자는 시드 스크립트로 만듭니다. `disableSignUp` 상태에서 admin 플러그인 `createUser`를 서버에서 부를 수 있는지는 구현할 때 확인하세요.

### 3.3 Next 16에서 라우트를 보호하는 정확한 방법 (두 겹)

**① `proxy.ts`: 낙관적 검사만 합니다.** 프로젝트 루트(`app/`과 같은 레벨)에 두고, 함수명은 `proxy`, `runtime` export는 금지(빌드 에러)입니다.
```ts
// proxy.ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {            // 쿠키 존재만 확인. DB 조회 금지 (prefetch 포함 모든 요청에 실행)
    const url = new URL('/login', request.url);
    url.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // 정적 자산, 로그인, auth 핸들러, 기계용 엔드포인트(자체 인증)를 제외
  matcher: ['/((?!login|api/auth|api/ingest|api/cron|_next/static|_next/image|favicon.ico).*)'],
};
```
Better Auth 문서도 이 방식을 **"NOT SECURE"(낙관적 리다이렉트 전용)**라고 명시합니다. 16.1.1의 Proxy 우회 advisory까지 감안하면 Proxy만 믿으면 안 됩니다.

**② DAL: 실제 검사입니다.** 모든 page, Server Action, Route Handler, 데이터 함수에서 호출합니다.
```ts
// lib/auth/dal.ts
import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';

export const getSession = cache(async () =>
  auth.api.getSession({ headers: await headers() }));

export const requireAdmin = cache(async () => {
  const s = await getSession();
  if (!s || s.user.role !== 'admin') redirect('/login');
  return s;
});

// Route Handler용: redirect 대신 null을 받아서 401/403 응답
export async function getAdminOrNull() {
  const s = await getSession();
  return s && s.user.role === 'admin' ? s : null;
}
```
규칙은 네 가지입니다.
- (a) **레이아웃에서만 검사하지 않습니다.** 레이아웃은 내비게이션 때 다시 렌더되지 않고, 하위 세그먼트 렌더를 막지도 못합니다(authentication 문서 "Layouts and auth checks").
- (b) `lib/data/*`의 모든 조회 함수 첫 줄에서 `requireAdmin()`을 호출해 **깜빡할 수 없게** 만듭니다.
- (c) Server Action 안에서 반드시 다시 검증합니다(data-security 문서).
- (d) `/api/ingest`는 사이트별 API 키(해시로 저장) 또는 HMAC으로, `/api/cron/*`는 `Authorization: Bearer ${CRON_SECRET}`로 핸들러 안에서 검증합니다.

로그인 Server Action 스케치:
```ts
'use server';
import * as z from 'zod';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';

const LoginSchema = z.object({ email: z.email(), password: z.string().min(1).max(256) });

export async function login(_prev: { error?: string } | undefined, formData: FormData) {
  const parsed = LoginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: '입력값을 확인하세요.' };
  try {
    await auth.api.signInEmail({ body: parsed.data, headers: await headers() });
  } catch {
    return { error: '이메일 또는 비밀번호가 올바르지 않습니다.' };
  }
  redirect('/'); // try/catch 밖에서
}
```

**대안(직접 구현)** 은 Better Auth 의존을 원치 않을 때 씁니다.
- 테이블: `admin_users(id, email unique, password_hash, role, disabled_at)`, `admin_sessions(id = sha256(token), user_id, expires_at, ip, user_agent)`, `login_attempts`
- 해시: `@node-rs/argon2`
- 쿠키: 불투명 랜덤 토큰, `httpOnly; secure; sameSite=lax`
- Proxy에서는 쿠키 존재만, DAL에서는 DB로 세션을 조회합니다. 구조는 위와 같습니다.

---

## 4. 권고 3: 차트

### 4.1 번들 크기 실측
esbuild `--minify`, gzip -9, react 외부화, 스크래치패드에서 측정했습니다.

| 라이브러리 (import 구성) | min | gzip |
|---|---|---|
| **ECharts 6.1** core: Line + Grid, Tooltip, DataZoom, MarkArea + Canvas | 547 KB | **186 KB** |
| ECharts 6.1 확장 (+Bar, Scatter, MarkLine, Legend, Dataset, VisualMap) | 644 KB | 216 KB |
| ECharts 6.1 전체 import | 1114 KB | 373 KB |
| Chart.js 4.5.1 (line, linear+time, tooltip, legend, decimation, filler) + zoom 2.2.0 + annotation 3.1.0 + date-fns adapter | 290 KB | 95 KB |
| Recharts 3.10.1 (LineChart, Line, 축, Tooltip, Brush, ReferenceArea, Responsive, Legend) | 385 KB | 112 KB |
| uPlot 1.6.32 | 50 KB | 22 KB |

### 4.2 요구사항별 비교

| 요구 | ECharts 6 | uPlot | Recharts 3 | Chart.js 4 |
|---|---|---|---|---|
| 수만 포인트 | Canvas + `sampling:'lttb'`, `large`/`progressive`. **5만 포인트 + LTTB + markArea 구성을 Node SSR로 147ms에 렌더(실측)** | 가장 빠름(10만/ms 수준) | **SVG DOM이라 부적합** | decimation 플러그인은 `parsing:false`, 선형/시간축, line에서만 동작 |
| 줌/팬 | `dataZoom` inside+slider 기본 제공 | 휠 줌/팬은 **플러그인 직접 작성** | Brush 정도 | chartjs-plugin-zoom |
| 다중 축 | `yAxis[]` + `yAxisIndex` | 지원 | 지원 | 지원 |
| 이벤트 밴드 | `markArea` / `markLine` 기본 | hooks로 직접 그리기 | ReferenceArea | annotation 플러그인 |
| 기타 O&M 차트 | heatmap, scatter, boxplot, calendar, visualMap, `echarts.connect`(커서 동기화) | 시계열 위주 | 일반 | 일반 |
| 리포트용 서버 렌더 | **`ssr:true` + `renderToSVGString()` 동작 확인**(52KB SVG) | 불가 | 불가 | node-canvas 필요 |
| React 19 / Compiler | 명령형이라 ref+effect 래퍼로 안전. **deep-freeze한 option도 그대로 받고 원본을 변경하지 않음(실측)** | 명령형, 안전 | peer ^19, 내부에 redux/immer | react-chartjs-2 peer ^19. 단 Chart.js는 **확장 가능한 data 배열의 push/splice 등을 패치**함(소스 `listenArrayEvents`, 동결 배열은 건너뜀) → props 불변 가정과 어긋남 |

### 4.3 권고: ECharts 1개로 통일
- gzip 186KB는 관리자 콘솔에서 감당할 만합니다. 차트를 쓰는 라우트에서만 로드됩니다.
- 한 라이브러리로 네 가지를 해결합니다: 줌/팬, 다중 축, 이벤트 밴드, 히트맵/산점도, 리포트 SVG.
- `echarts-for-react`는 쓰지 않고 **40줄짜리 자체 래퍼**를 둡니다. 의존성 1개가 줄고 option 비교 비용을 직접 통제할 수 있습니다.
- uPlot은 나중에 고주파 원시 파형 뷰가 생기면 그때 보조로 씁니다.

```tsx
// components/charts/EChart.tsx
'use client';
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent,
         MarkLineComponent, LegendComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([LineChart, ScatterChart, HeatmapChart, GridComponent, TooltipComponent, DataZoomComponent,
  MarkAreaComponent, MarkLineComponent, LegendComponent, VisualMapComponent, CanvasRenderer]);

type Props = { option: EChartsCoreOption; group?: string; className?: string };

export function EChart({ option, group, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    const c = echarts.init(el.current!);
    chart.current = c;
    if (group) { c.group = group; echarts.connect(group); }
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, [group]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return <div ref={el} className={className ?? 'h-80 w-full'} />;
}
```

다중 축과 이벤트 밴드 option 예:
```ts
const option = {
  animation: false,
  tooltip: { trigger: 'axis' },
  legend: {},
  xAxis: { type: 'time' },
  yAxis: [{ type: 'value', name: 'kW' }, { type: 'value', name: '°C', position: 'right' }],
  dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider' }],
  series: [
    { name: 'AC 출력', type: 'line', showSymbol: false, sampling: 'lttb', data: power, // [ts, value][]
      markArea: { itemStyle: { opacity: 0.15 },
        data: events.map(e => [{ name: e.label, xAxis: e.start }, { xAxis: e.end }]) } },
    { name: '모듈 온도', type: 'line', yAxisIndex: 1, showSymbol: false, data: temp },
  ],
};
```

**핵심은 브라우저에 원시 포인트를 다 보내지 않는 것입니다.** TimescaleDB 없이 PG14+ `date_bin`으로 화면 해상도에 맞춰 min/avg/max를 집계합니다. `dataZoom` 이벤트가 오면 디바운스한 뒤 `/api/series`로 좁은 구간을 다시 조회합니다.
```sql
-- 차트용 버킷 집계. $1 = (to - from) / 목표포인트(약 2000)
SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
       avg(value) AS avg, min(value) AS min, max(value) AS max, count(*) AS n
FROM samples
WHERE asset_id = $2 AND metric_id = $3 AND ts >= $4 AND ts < $5
GROUP BY 1
ORDER BY 1;
```
```ts
// app/api/series/route.ts
import type { NextRequest } from 'next/server';
import * as z from 'zod';
import { getAdminOrNull } from '@/lib/auth/dal';
import { getBucketedSeries } from '@/lib/data/series';

const Query = z.object({
  assetId: z.coerce.number().int().positive(),
  metric: z.string().min(1).max(64),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  points: z.coerce.number().int().min(100).max(5000).default(2000),
});

export async function GET(req: NextRequest) {
  if (!(await getAdminOrNull())) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return Response.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
  return Response.json({ data: await getBucketedSeries(parsed.data) });
}
```
리포트 PDF나 이메일용 정적 차트는 서버에서 `echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })` → `renderToSVGString()`으로 만듭니다. 실측 중 확인한 점이 있습니다. **렌더 후 `chart.dispose()`를 부르지 않으면 Node 프로세스가 끝나지 않습니다.** 스크립트와 크론에서 반드시 dispose하세요.

---

## 5. 권고 4: 지도

- **Kakao Maps 유지**를 권고합니다. 전국 국내 사이트에는 한국 지도 품질이 낫고 기존 키와 도메인 등록 자산이 있습니다.
- 다만 콘솔에서 지도는 **개요 위젯**이지 주 화면이 아닙니다.
- **`react-kakao-maps-sdk@1.2.2`로 전환**합니다(2026-08 릴리스, peer React ^19).
  - `useKakaoLoader({ appkey })` 훅이 있어 `<Script>`와 `window.kakao` 수동 관리가 필요 없습니다(패키지 `dist/hooks/useKakaoLoader.d.ts` 확인).
  - `CustomOverlayMap`과 `MapMarker`가 **React children을 받습니다.** 지금 `MapTab.tsx`는 `innerHTML` 템플릿 문자열에 `site.name`을 그대로 넣고 있어 XSS 위험이 있는데, 이게 없어지고 lucide 아이콘도 쓸 수 있습니다.
  - `MarkerClusterer`를 지원합니다. 타입은 `kakao.maps.d.ts`입니다.
- **`leaflet`, `react-leaflet`, `@types/leaflet` 삭제.** grep 결과 import가 0건입니다.
- Kakao JS 키는 `NEXT_PUBLIC_`으로 노출되는 게 정상입니다. 대신 Kakao Developers에서 **허용 도메인**(localhost, Vercel 도메인)을 제한하세요.
- 대안: 해외 사이트가 생기거나 오프라인, 위성 요구가 있으면 Leaflet + VWorld 타일을 검토합니다.

---

## 6. 권고 5: DB 접근, 마이그레이션, 입력 검증

### 6.1 권고 조합
- **드라이버:** `pg` 유지, 8.23으로 올립니다. Next 기본 `serverExternalPackages`에 `pg`가 포함돼 있습니다.
- **쿼리:** **Kysely 0.29.5**(Node ≥22 요구, 로컬 22.20 충족).
  - Better Auth가 내부에서 Kysely를 써서 스택이 겹칩니다.
  - 메트릭 레지스트리, 시계열 롤업, 조건 매칭 비교처럼 SQL이 중심인 분석 쿼리는 `sql` 템플릿과 타입 빌더를 섞어 쓰기 좋습니다.
  - 0.30은 beta입니다(`transactionMode` 등).
- **마이그레이션:** **순수 SQL 파일 + dbmate 2.35**(npm에 `@dbmate/win32-x64` 바이너리 포함).
  - 파일 하나에 `-- migrate:up` / `-- migrate:down`을 둡니다. `CREATE INDEX CONCURRENTLY`는 `transaction:false`로 씁니다.
  - 로컬 Docker와 RDS에 **같은 파일**을 적용합니다.
  - 파티셔닝, BRIN, generated column, materialized view, pg_partman(RDS 지원) 같은 PG 고급 DDL을 제약 없이 씁니다.
- **타입:** `kysely-codegen`으로 DB를 introspect해 `lib/db/types.gen.ts`를 만듭니다. 원천은 SQL이고, 타입은 DB에서 생성합니다.
- **Drizzle을 택하지 않은 이유:** `drizzle-orm` latest는 0.45.2이고 1.0은 `rc.5`라 전환기입니다. 스키마 DSL을 거치면 선언적 파티셔닝이나 커스텀 DDL을 표현하기 어렵습니다. Better Auth와도 겹치지 않습니다.
- **node-pg-migrate 9도 가능**하지만 dbmate가 언어 중립적이고 파일 형식이 더 단순합니다.
- **Windows 주의:** dbmate는 `up`할 때 `pg_dump`로 `db/schema.sql`을 자동 덤프합니다. 로컬에 `pg_dump`가 없으면 `DBMATE_NO_DUMP_SCHEMA=true`를 쓰거나 `docker compose exec db pg_dump`로 대체하세요.

```ts
// lib/db/pool.ts: 'server-only'를 넣지 않음 (tsx 스크립트와 Vitest에서도 import하므로. 6.3 참고)
import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';

const g = globalThis as unknown as { __pool?: Pool };

export const pool = g.__pool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.DATABASE_SSL_CA
    ? { ca: process.env.DATABASE_SSL_CA, rejectUnauthorized: true } // RDS global-bundle.pem
    : undefined,                                                     // 로컬 Docker
});
if (process.env.NODE_ENV !== 'production') g.__pool = pool; // dev HMR 재연결 방지
if (process.env.VERCEL) attachDatabasePool(pool);            // Fluid compute 유휴 연결 정리

// lib/db/kysely.ts
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.gen';
export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
```
현재 `lib/db.ts`의 `ssl: { rejectUnauthorized: false }`는 TLS 검증을 끈 상태입니다. **RDS CA 번들로 검증을 켜세요.**

```sql
-- db/migrations/20260915000000_init_registry.sql (형식 예시)
-- migrate:up
CREATE TABLE metric_definitions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          text NOT NULL UNIQUE,          -- 'battery.soc', 'electrolyzer.stack_voltage'
  unit         text NOT NULL,
  asset_type   text NOT NULL,
  value_kind   text NOT NULL CHECK (value_kind IN ('gauge','counter','state')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- migrate:down
DROP TABLE metric_definitions;
```
스키마 설계 자체는 다른 에이전트가 맡은 범위입니다. 여기서는 형식만 보여 줍니다.

Kysely에서 원시 SQL을 타입과 함께 실행하는 방식:
```ts
import { sql } from 'kysely';
type Bucket = { bucket: Date; avg: number; min: number; max: number; n: string };
const { rows } = await sql<Bucket>`
  SELECT date_bin(${interval}::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
         avg(value) AS avg, min(value) AS min, max(value) AS max, count(*) AS n
  FROM samples WHERE asset_id = ${assetId} AND metric_id = ${metricId}
    AND ts >= ${from} AND ts < ${to}
  GROUP BY 1 ORDER BY 1`.execute(db);
```

### 6.2 zod
- 설치된 4.3.5는 eslint-plugin-react-hooks 등의 **전이 의존성**입니다. `npm i zod@^4.6`으로 직접 추가하세요.
- v4 문법을 씁니다: `import * as z from 'zod'`, `z.email()`, `z.iso.datetime()`, `z.treeifyError()`, `{ error: '...' }`. Next 16 문서 예제도 v4 문법입니다.
- 검증 지점:
  - 수신 페이로드(메트릭 키가 레지스트리에 있는지는 DB로 대조)
  - Server Action의 FormData
  - Route Handler의 쿼리 파라미터
  - 환경 변수(시작할 때 `z.object({...}).parse(process.env)`)

### 6.3 `server-only` 함정 (실측)
- `server-only` 패키지는 `react-server` export 조건이 없으면 **import하는 순간 throw합니다.** 순수 Node, tsx, Vitest가 모두 여기에 해당합니다.
- 해결 방법:
  - `import 'server-only'`는 `lib/data/*`와 `lib/auth/*`처럼 Next 전용 모듈에만 넣습니다.
  - `lib/db/pool.ts`, `lib/analytics/*`, `lib/ingest/*`에는 넣지 않습니다.
  - 필요하면 스크립트를 `tsx --conditions=react-server`로 실행하거나, Vitest에서 `server-only`를 빈 모듈로 alias합니다.

---

## 7. 권고 6: 아이콘

**Font Awesome CDN을 lucide-react 1.45로 교체**합니다.
- 현재 CDN 방식의 문제:
  - 외부 렌더 차단 CSS에 의존합니다. `layout.tsx`의 `<link>`로 all.min.css를 통째로 불러옵니다.
  - 나중에 CSP를 적용할 때 예외가 필요합니다.
  - Kakao 오버레이 `innerHTML` 안의 클래스 문자열이라 타입 검사가 안 됩니다.
- lucide-react 1.x:
  - 트리셰이킹됩니다(아이콘 10개가 gzip 2KB, 실측).
  - v1에서 브랜드 아이콘이 빠졌지만 이 콘솔과는 무관합니다.
  - 필요한 도메인 아이콘이 있는지 확인했습니다: `SolarPanel`, `BatteryCharging`, `BatteryWarning`, `Zap`, `Gauge`, `Thermometer`, `Factory`, `Fuel`, `Cylinder`, `Droplets`, `Flame`, `Wrench`, `TriangleAlert`, `Activity`, `ChartLine`, `MapPinned`, `FileText`.
  - 전해조, 연료전지 전용 아이콘은 없습니다. `Droplets`/`Cylinder`/`Fuel` 조합이나 "H₂" 텍스트 배지를 쓰세요.
- 곁들여 볼 점: `next/font`의 Inter는 `subsets:['latin']`이라 한글 글리프가 없어 시스템 폰트로 대체됩니다. Pretendard(local)나 Noto Sans KR을 검토하세요.

---

## 8. 권고 7: 테스트

### 8.1 계층
1. **Unit (Vitest):** `lib/analytics/**` 순수 함수. 입력은 배열/레코드, 출력은 finding/점수이고 I/O가 없습니다. 예: 조건 매칭 충전 세션 비교, 기준선 대비 변화율, 효율 저하 판정. 결정적 fixture와 시드 고정 PRNG를 씁니다. **커버리지 80%는 이 폴더에 적용**합니다.
2. **Integration (Vitest, 실제 PG):** `lib/data/**`의 SQL(버킷 집계, 롤업, 조건 매칭 쿼리)을 Docker의 `solar_test` DB에서 검증합니다. `fileParallelism: false`, globalSetup에서 `dbmate up`과 시드를 실행합니다.
3. **E2E (Playwright):** 로그인 → 사이트 목록 → 부품 상세 차트 렌더 → finding 확인 액션 → 리포트 페이지.
- Next 문서 기준으로 **async Server Component는 Vitest가 지원하지 않으니 E2E로** 커버합니다.
- **E2E는 프로덕션 빌드를 대상으로** 돌리라는 게 Next 문서의 권고입니다.

```ts
// vitest.config.mts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    tsconfigPaths: true, // Vite 8 내장. 테스트 환경 미적용 이슈(vitest#10054) 시 vite-tsconfig-paths로 대체
    alias: { 'server-only': fileURLToPath(new URL('./tests/stubs/empty.ts', import.meta.url)) },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['lib/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false, globalSetup: ['tests/integration/global-setup.ts'] } },
    ],
    coverage: { provider: 'v8', include: ['lib/analytics/**'], thresholds: { lines: 80 } },
  },
});
```
- 버전: Vitest 5.0.0은 2026-09-03 출시로 아직 새 버전입니다. 요구사항은 Node ^22.12, Vite 6.4 이상입니다.
- 순수 TS 테스트라 위험은 낮으니 5.x를 **정확한 버전으로 고정**하고, 문제가 생기면 `vitest@4.1.11`(dist-tag V4)로 내리세요.
- React 컴포넌트 단위 테스트는 초기에는 두지 않습니다. `jsdom`, `@testing-library/react`, `@vitejs/plugin-react`(Vite 8 요구)는 필요할 때 추가합니다.

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,                     // 공유 테스트 DB
  use: { baseURL: 'http://localhost:3100', trace: 'on-first-retry' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },  // 1회 로그인 → storageState 저장
    { name: 'chromium', dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' } },
  ],
  webServer: {
    command: 'npm run build && npm run start -- -p 3100',
    url: 'http://localhost:3100/login',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {                          // Windows에서 VAR=x 문법 대신 이걸로 주입 (크로스플랫폼)
      DATABASE_URL: 'postgres://solar:solar@localhost:54320/solar_test',
      BETTER_AUTH_URL: 'http://localhost:3100',
      BETTER_AUTH_SECRET: 'e2e-only-secret-change-me',
    },
  },
});
```

### 8.2 Windows 주의점
- **환경 변수:** npm 스크립트의 `FOO=bar cmd` 문법은 cmd에서 동작하지 않습니다. Playwright는 `webServer.env`, 스크립트는 `tsx --env-file=.env.local`, 그 밖에는 `cross-env`를 쓰세요.
- **줄바꿈:** 이 레포에서 실제로 `LF will be replaced by CRLF` 경고가 났습니다. `.gitattributes`에 `* text=auto eol=lf`를 두면 SQL/스냅샷/fixture diff 노이즈를 막을 수 있습니다.
- **Next 16 lockfile:** 같은 프로젝트에서 `next dev`를 두 번 띄울 수 없습니다. E2E는 `next start`를 다른 포트에 띄웁니다. build 출력은 `.next`, dev 출력은 `.next/dev`로 분리돼 있어 공존할 수 있습니다.
- **브라우저:** `npx playwright install chromium`만 설치하면 됩니다(`%LOCALAPPDATA%\ms-playwright`).
- **`localhost` 해석:** Node가 IPv6(`::1`)로 먼저 해석할 수 있습니다. webServer 대기가 멈추면 `next start -H 127.0.0.1`과 baseURL을 같은 호스트로 맞추세요.
- **포트 충돌:** 로컬에 PostgreSQL 서비스가 설치돼 있으면 5432가 겹칩니다. compose는 `54320:5432`로 매핑합니다.
- **속도:** Windows Defender 실시간 검사가 `node_modules`와 `.next` I/O를 크게 늦춥니다. 프로젝트 폴더를 제외 대상에 넣는 것을 권장합니다(선택).
- **`server-only`:** Vitest와 tsx에서 throw합니다(6.3 참고).

---

## 9. 권고 8: 로컬 개발 (Docker + 시드/시뮬레이터)

### 9.1 docker-compose
**RDS와 같은 메이저 버전**을 씁니다. RDS는 PG 18(18.1부터)과 17을 지원하니 현재 RDS 버전을 확인해야 합니다.
```yaml
# docker-compose.yml
services:
  db:
    image: postgres:17-bookworm      # RDS가 18이면 postgres:18-bookworm
    environment:
      POSTGRES_USER: solar
      POSTGRES_PASSWORD: solar
      POSTGRES_DB: solar
      TZ: UTC
    ports: ["54320:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data   # PG 18 이미지는 /var/lib/postgresql 로 마운트 (PGDATA 경로 변경됨)
      - ./db/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U solar -d solar"]
      interval: 5s
      retries: 20
volumes:
  pgdata:
```
```sql
-- db/init/01-test-db.sql
CREATE DATABASE solar_test;
```
- **PG 18 이미지는 볼륨 경로가 바뀌었습니다.** 기존처럼 `/var/lib/postgresql/data`에 마운트하면 데이터가 볼륨 밖에 쓰이거나 컨테이너가 기동하지 않습니다.
- alpine(musl) 이미지는 로케일/콜레이션 동작이 RDS와 다를 수 있으니 **debian 계열 이미지**를 권장합니다.

### 9.2 스크립트
```jsonc
// package.json scripts (발췌)
{
  "db:up": "docker compose up -d --wait db",
  "db:migrate": "dbmate --env-file .env.local --wait up",
  "db:new": "dbmate new",
  "db:types": "kysely-codegen --dialect postgres --out-file lib/db/types.gen.ts",
  "db:seed": "tsx --env-file=.env.local scripts/seed.ts",
  "sim:backfill": "tsx --env-file=.env.local scripts/simulate.ts --mode backfill --days 120",
  "sim:live": "tsx --env-file=.env.local scripts/simulate.ts --mode live --interval 60",
  "analyze": "tsx --env-file=.env.local scripts/run-analysis.ts",
  "test": "vitest run --project unit",
  "test:int": "vitest run --project integration",
  "test:e2e": "playwright test"
}
```
- **tsx를 쓰는 이유:** Node 22.20은 `.ts`를 네이티브로 실행합니다(실측). 하지만 `@/` tsconfig paths는 해석하지 못해 `ERR_MODULE_NOT_FOUND`가 납니다(실측). tsx 4.23은 paths를 지원합니다.
- 시뮬레이터 설계 원칙:
  - `lib/ingest/ingestBatch.ts`를 Route Handler와 공유합니다. `--via http` 옵션을 주면 실제 `/api/ingest`로 POST합니다.
  - PRNG 시드를 고정합니다.
  - 일사량과 시간대 곡선을 반영합니다. 현재 코드는 **밤에도 용량의 85~95%를 발전**시킵니다.
  - 열화 시나리오를 주입합니다: 배터리 SOH 저하(같은 V/I/온도 조건에서 충전 0→100%가 8h에서 7.5h로 단축), 인버터 효율 저하, 전해조 비에너지소비(kWh/kg) 상승, 연료전지 셀전압 감쇠.
  - **분석 엔진이 이 시나리오를 잡아내는지** 통합 테스트로 확인합니다.
- **Vercel 운영 제약** (확인 완료):
  - Cron: Hobby는 **하루 1회, ±59분 정밀도**, Pro는 분 단위.
  - 함수 최대 실행 시간: Hobby 300s, Pro 800s.
  - 요청/응답 바디: 4.5MB. 수신은 배치 크기를 제한해야 합니다.
  - 함수 기본 리전: `iad1`(미국 동부). RDS가 서울이면 `vercel.json`에 `"regions": ["icn1"]`을 넣으세요.

---

## 10. 권고 9: 현재 코드에서 재사용할 것과 버릴 것 (파일 단위)

### 재사용 (수정 후)

| 파일 | 재사용할 부분 | 조치 |
|---|---|---|
| `next.config.ts` | `reactCompiler: true` | 유지. 필요 시 `typedRoutes` 추가 |
| `tsconfig.json` | `strict`, `@/*` paths, bundler resolution | 유지 |
| `eslint.config.mjs` | flat config + next vitals/ts | 유지 (eslint-config-next 16.3.5) |
| `postcss.config.mjs`, `app/globals.css` | Tailwind 4 설정 | 유지. `--font-geist-*` 미정의 변수와 `body{font-family:Arial}` 정리 |
| `app/layout.tsx` | 루트 레이아웃 골격, `lang="ko"` | FA CDN `<link>` 제거, 메타데이터와 한글 폰트 교체 |
| `lib/db.ts` | 싱글톤 Pool, 작은 `max` | `lib/db/pool.ts`로 재작성: `DATABASE_URL`, TLS 검증, `attachDatabasePool`, Kysely |
| `vercel.json` | crons 개념 | 경로를 `/api/cron/*`로 교체하고 `CRON_SECRET` 검증, `regions` 추가 |
| `app/api/weather/route.ts` | OpenWeather 좌표 조회 매핑(temp, humidity, main) | 공개 라우트 대신 **서버 크론 수집기**(`lib/weather`)로 이동. **실패 시 가짜 값(20°C/Clear)을 반환하는 부분은 삭제**합니다. 분석 데이터를 오염시킵니다 |
| `app/api/solar/route.ts` | 사이트별 최신값을 가져오는 `LEFT JOIN LATERAL ... LIMIT 1` 패턴, N+1 회피, 날씨 문자열 분류 키워드 | DAL 조회 함수로 이식. 하드코딩(`SMP=160`, `install_date:'2023-01-15'`, `health_score` 임계값, 가짜 인버터 생성)은 버림 |
| `components/tabs/MapTab.tsx` | Kakao 초기화와 오버레이 지식, 상태 색상 매핑, `getWeatherInfo` 매핑, 모바일 패널 UX 아이디어 | `react-kakao-maps-sdk` + React children으로 재작성. `innerHTML` 제거 |
| `components/tabs/MaintenanceTab.tsx` | 우선순위 정렬(심각도 → 최신순), 상태 카운트 카드 레이아웃 | findings 목록으로 이식. **`failureTypeData`의 하드코딩 [12,5,8,3,2]는 삭제** |
| `components/tabs/RevenueTab.tsx` | SMP/REC 카드 UI | 개요 화면의 "수익 요약 위젯"으로 축소 |
| `components/tabs/EfficiencyTab.tsx` | "효율 하위 N개" 목록 아이디어 | 조건 보정 효율 순위로 재구현. 하드코딩된 "2.1% (전년 대비)", "기상청 데이터 일치"는 삭제 |
| `app/page.tsx` (일부 로직만) | 날씨 계수와 P=V·I 역산 아이디어 | `scripts/simulate.ts`의 출발점으로만 참고(시간대/일사량 모델로 대체) |

### 폐기 (삭제)

| 파일 | 이유 |
|---|---|
| `app/page.tsx` | 단일 클라이언트 페이지 + 브라우저 폴링 3종 + `any` 남발. 탭을 열어야만 데이터가 생기고, 탭이 여러 개면 INSERT가 중복됨. `next/dynamic` import는 미사용 |
| `components/layout/Header.tsx`, `components/layout/Sidebar.tsx`, `components/Maps.tsx` | **어디서도 import하지 않는 죽은 코드**(grep 확인). Header에 날짜 `2026-01-06` 하드코딩 |
| `app/api/solar/cleanup/route.ts` | **24시간 지난 로그 삭제**는 "조건을 맞춘 과거 대비 변화"라는 핵심 요구와 정면으로 충돌. 인증도 없어 누구나 호출 가능. 원시 데이터는 파티션 단위 보존 정책과 롤업으로 대체 |
| `app/api/solar/weather-history/route.ts` | 인증 없음. `client.release()`가 `finally` 밖이라 **쿼리 에러 시 커넥션 누수** |
| `app/api/solar/route.ts`의 POST | 인증 없는 쓰기 엔드포인트. `site_id || 1` 기본값으로 잘못된 사이트에 기록됨 |
| `public/*.svg` (file, globe, next, vercel, window) | create-next-app 기본 자산, 미사용 |
| `package.json`의 `leaflet`, `react-leaflet`, `@types/leaflet`, `"solar-dashboard": "file:"` | 미사용, 자기참조 |
| `chart.js`, `react-chartjs-2` | ECharts로 통일한 뒤 제거 |
| DB 테이블 `solar_stats`, `solar_market`, `solar_schedule`, `solar_revenue`, `solar_actions` | 가짜 또는 하드코딩 성격. 스냅샷 백업 후 새 스키마로 대체 |
| DB 테이블 `solar_sites`, `solar_weather_history` | **데이터는 이관 후보.** 좌표·용량 등 사이트 마스터와 실제 날씨 이력. 새 `sites` 테이블과 날씨 테이블로 1회 데이터 마이그레이션 |
| `README.md` | Next 15 표기, 존재하지 않는 "AI 예지보전" 기능을 설명함. 재작성 |

---

## 11. 적용 순서 제안
1. **보안 기반 정리 (반나절)**
   - `next@16.3.5 react@19.3 react-dom@19.3 eslint-config-next@16.3.5`로 업그레이드
   - 미사용 의존성 제거, `.gitattributes` 추가
   - 인증 없는 쓰기/삭제 API와 브라우저 시뮬레이터 제거
   - 확인: `npm audit`에 next 항목 0건, `next build` 통과
2. **데이터 기반**
   - docker compose, dbmate 초기 마이그레이션, Kysely와 codegen, 시드와 시뮬레이터 backfill
   - 확인: `db:migrate`를 빈 DB에 2번 실행해도 idempotent, 시뮬레이터 데이터가 기대 행 수와 일치
3. **인증 골격**
   - Better Auth, `proxy.ts`, DAL, `(auth)`/`(console)` 라우트 그룹
   - 확인: 비로그인 E2E에서 모든 콘솔 URL과 Server Action과 `/api/series`가 차단되는지 테스트
4. **분석 엔진과 화면**
   - `lib/analytics` TDD, 크론 분석, ECharts 화면, Kakao 위젯, 리포트 템플릿과 `NarrativeGenerator` 인터페이스
