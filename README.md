# HySol Desk

태양광·ESS·수전해·수소저장·연료전지 설비의 원시데이터를 분석해 사이트별 유지보수 코칭까지 잇는 관리자 전용 O&M 분석 콘솔입니다.

- 설계 문서: [docs/renewal/README.md](docs/renewal/README.md)

## 로컬 개발

> **운영 DB 주의:** 로컬 개발과 테스트는 `localhost:54320`의 embedded-postgres만 씁니다. `.env.local`에 있는 운영 AWS RDS 접속정보(`DB_HOST` 등)는 새 코드가 읽지 않으며, 수정·삭제하지 마세요. 새 코드는 `DATABASE_URL`만 사용하고, 테스트는 `localhost:54320/hysol_test`가 아니면 실행을 거부합니다.

### 사전 준비

- Node.js 22.12 이상
- Docker는 필요 없습니다. [embedded-postgres](https://github.com/leinelissen/embedded-postgres)가 PostgreSQL 17을 로컬 프로세스로 실행합니다(데이터: `.data/pg`, 포트 54320). 관리자 권한이 아닌 일반 셸에서 실행하세요.

### 시작하기

1. 환경변수 파일을 만들고 값을 채웁니다. `BETTER_AUTH_SECRET`은 32자 이상 랜덤 값이며 생성 명령은 `.env.example`에 있습니다.
   ```bash
   cp .env.example .env.development.local
   ```
2. 의존성을 설치합니다.
   ```bash
   npm install
   ```
3. **별도 터미널**에서 DB 서버를 켜 두고 그대로 둡니다. 최초 실행 시 `hysol`·`hysol_test` DB를 만듭니다.
   ```bash
   npm run db:up      # Ctrl+C로 종료. 터미널을 닫지 못했으면 npm run db:down
   ```
4. 개발 DB를 마이그레이션합니다.
   ```bash
   npm run db:migrate
   ```
5. 관리자 계정을 만듭니다. 가입이 비활성이라 계정은 이 스크립트로만 만듭니다.
   ```bash
   npm run admin:create -- --email admin@hysol.local --password '<12자 이상>' --name 관리자
   ```
6. 개발 서버를 실행하고 http://localhost:3000/login 에서 로그인합니다.
   ```bash
   npm run dev
   ```

| 스크립트 | 설명 |
|---|---|
| `db:migrate:down` | 마지막 마이그레이션 1개 되돌리기 |
| `db:migrate:test` | 테스트 DB 마이그레이션 (integration·e2e가 시작할 때 같은 작업을 자동으로 한다) |
| `db:types` | DB에서 `lib/db/types.ts` 생성 (om, public 스키마) |
| `db:reset` | **로컬 전용.** 개발 DB 스키마를 모두 지우고 다시 migrate. `localhost:54320`이 아니면 중단 |
| `admin:create` / `admin:create:test` | 개발 / 테스트 DB에 관리자 계정 생성. 이미 있으면 안내 후 종료 |
| `typecheck` / `lint` | `tsc --noEmit` / ESLint |

### 테스트

테스트용 환경변수 파일을 한 번 만듭니다. `DATABASE_URL`의 DB 이름을 `hysol_test`로 바꾸고, `BETTER_AUTH_SECRET`은 개발용과 다른 값, `E2E_ADMIN_PASSWORD`(12자 이상)를 채웁니다. E2E 브라우저도 한 번 설치합니다.

```bash
cp .env.example .env.test.local
npx playwright install chromium
```

integration·e2e는 `npm run db:up`이 떠 있어야 합니다. 꺼져 있으면 서버를 대신 띄우지 않고 "먼저 npm run db:up 을 실행하세요" 오류로 멈춥니다.

| 명령 | 내용 |
|---|---|
| `npm test` / `npm run test:unit` | Vitest unit (`lib/**`, `components/**`의 `*.test.ts`). DB 불필요 |
| `npm run test:integration` | Vitest integration (`tests/integration`). 테스트 DB를 최신으로 migrate한 뒤 스키마·마이그레이션 왕복을 검사 |
| `npm run test:e2e` | Playwright (`tests/e2e`, chromium). `next build` 후 `next start -p 3100`을 띄우고, 테스트 DB migrate와 테스트 관리자(`e2e-admin@hysol.local`) 재생성 후 실행 |
| `npm run test:all` | unit → integration → e2e 순서로 모두 실행 |
| `npx vitest run --project unit --coverage` | `lib/**` 커버리지 (`coverage/`) |

integration은 테스트 DB의 마이그레이션을 모두 되돌렸다가 다시 적용하므로 e2e와 동시에 실행하지 마세요.

## 인증

Better Auth(이메일+비밀번호, 가입 비활성, admin 플러그인, DB 세션·rate limit)를 씁니다. 테이블은 `auth_*`이고 `db/migrations`로만 관리합니다(`auth migrate`를 직접 실행하지 않음).

- `proxy.ts`는 세션 쿠키가 있는지만 보고 없으면 `/login`으로 보냅니다.
- 실제 검사는 `lib/auth/dal.ts`의 `requireAdmin()`입니다. 콘솔의 모든 page, Server Action, Route Handler 첫 줄에서 호출합니다.
- 로그인은 브라우저에서 `/api/auth/sign-in/email`로 보냅니다. 서버의 `auth.api.*` 호출에는 rate limit이 적용되지 않기 때문입니다.

새 마이그레이션은 SQL 파일로 만듭니다.

```bash
npx node-pg-migrate create <이름> -j sql -m db/migrations --migration-filename-format utc
```
