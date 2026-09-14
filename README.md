# HySol Desk

태양광·ESS·수전해·수소저장·연료전지 설비의 원시데이터를 분석해 사이트별 유지보수 코칭까지 잇는 관리자 전용 O&M 분석 콘솔입니다.

- 설계 문서: [docs/renewal/README.md](docs/renewal/README.md)

## 로컬 개발

> **운영 DB 주의:** 로컬 개발과 테스트는 `localhost:54320`의 embedded-postgres만 씁니다. `.env.local`에 있는 운영 AWS RDS 접속정보(`DB_HOST` 등)는 새 코드가 읽지 않으며, 수정·삭제하지 마세요. 새 코드는 `DATABASE_URL`만 사용하고, 테스트는 `localhost:54320/hysol_test`가 아니면 실행을 거부합니다.

### 사전 준비

- Node.js 22.12 이상
- Docker는 필요 없습니다. [embedded-postgres](https://github.com/leinelissen/embedded-postgres)가 PostgreSQL 17을 로컬 프로세스로 실행합니다(데이터: `.data/pg`, 포트 54320). 관리자 권한이 아닌 일반 셸에서 실행하세요.

### 시작하기

1. 환경변수 파일을 만들고 값을 채웁니다. `BETTER_AUTH_SECRET`(32자 이상)과 `INGEST_KEY_ENC_KEY`(base64 32바이트)는 랜덤 값이며 생성 명령은 `.env.example`에 있습니다.
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
5. 설비 카탈로그와 가상 사이트를 넣습니다.
   ```bash
   npm run db:seed
   ```
   - `om.asset_class`·`om.metric_def` 카탈로그와 가상 사이트 SIM-A(태양광+ESS)·SIM-B(연계형)·SIM-C(연계형 대조군)의 설비 트리·게이트웨이·포인트 매핑을 upsert합니다. 여러 번 실행해도 결과가 같습니다.
   - 게이트웨이 개발용 HMAC 비밀값 `SIM_GATEWAY_SECRET_<게이트웨이 코드>`가 env 파일에 없으면 생성해 파일 끝에 추가하고, DB에는 `INGEST_KEY_ENC_KEY`로 암호화해 저장합니다. 비밀값은 출력하지 않습니다.
   - 정의는 `db/seed/`(순수 데이터 모듈)에 있습니다. `db/seed/sites.ts`의 `UNMAPPED_SOURCE_TAGS`는 일부러 매핑하지 않는 태그라 DB에 넣지 않습니다(미매핑 인박스·재처리 시연용).
6. 관리자 계정을 만듭니다. 가입이 비활성이라 계정은 이 스크립트로만 만듭니다.
   ```bash
   npm run admin:create -- --email admin@hysol.local --password '<12자 이상>' --name 관리자
   ```
7. 개발 서버를 실행하고 http://localhost:3000/login 에서 로그인합니다.
   ```bash
   npm run dev
   ```

| 스크립트 | 설명 |
|---|---|
| `db:migrate:down` | 마지막 마이그레이션 1개 되돌리기 |
| `db:migrate:test` | 테스트 DB 마이그레이션 (integration·e2e가 시작할 때 같은 작업을 자동으로 한다) |
| `db:types` | DB에서 `lib/db/types.ts` 생성 (om, public 스키마. 파티션 자식 테이블은 제외) |
| `db:seed` / `db:seed:test` | 개발 / 테스트 DB에 카탈로그·가상 사이트 멱등 upsert. 게이트웨이 개발용 비밀값이 없으면 해당 env 파일에 생성 |
| `db:reset` | **로컬 전용.** 개발 DB 스키마를 모두 지우고 다시 migrate. `localhost:54320`이 아니면 중단 |
| `admin:create` / `admin:create:test` | 개발 / 테스트 DB에 관리자 계정 생성. 이미 있으면 안내 후 종료 |
| `typecheck` / `lint` | `tsc --noEmit` / ESLint |

### 데모 데이터 만들기

시뮬레이터(`lib/sim`)로 가상 사이트 SIM-A/B/C의 과거 데이터를 만들어 **실제 수집 API**(`POST /api/ingest/v1`, HMAC 서명·gzip)로 적재하고 DB에서 검증합니다. 개발 DB(`hysol`)에만 넣습니다.

1. 별도 터미널에서 DB 서버를 켭니다: `npm run db:up`
2. `npm run db:migrate`
3. `npm run db:seed` — 게이트웨이 키가 없으면 `.env.development.local`에 `SIM_GATEWAY_SECRET_*`를 만듭니다.
4. 별도 터미널에서 서버를 켭니다: `npm run dev`
5. 과거 30일치를 적재합니다.
   ```bash
   npm run sim:backfill -- --days 30 --sites SIM-A,SIM-B,SIM-C --seed 42 --base-url http://localhost:3000 --scenario dq
   ```
6. 적재 결과를 검증합니다: `npm run verify:ingest`

30일 × 3사이트는 샘플 약 738만 개, 1시간 배치 2,279개(재전송 포함)입니다. 이 PC 기준으로 적재에 `next dev` 약 1분(`next build` + `next start` 약 46초), 검증에 약 15초가 걸리고 DB가 약 750 MB 늘어납니다.

**`sim:backfill` 옵션**

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--days` | 30 | 적재 기간(일). 끝은 실행 시각을 배치 단위로 내림한 시각 |
| `--sites` | `SIM-A,SIM-B,SIM-C` | 적재할 사이트 |
| `--seed` | 42 | 같은 시드·기간이면 같은 데이터 |
| `--base-url` | `http://localhost:3000` | 수집 API 서버 |
| `--scenario` | `healthy` | `healthy`(시나리오 없음) 또는 `dq`(아래) |
| `--batch-minutes` | 60 | 게이트웨이 배치 길이(분) |
| `--max-samples` | 5000 | 배치당 최대 샘플 수. 넘으면 나눠 보냄 |
| `--concurrency` | 4 | 동시에 보내는 요청 수 |
| `--manifest` | `.data/sim/backfill-manifest.json` | `verify:ingest`가 읽는 적재 기록 |

`dq` 시나리오(3일 이상, SIM-A·SIM-B 필요): 전 사이트 중복 배치 5%, SIM-B 게이트웨이 6시간 단절 후 역순 백필, SIM-A +200초 시계 오차 12시간, SIM-A 일사계(`WX1/POA`) 8시간 고착, SIM-B 저장탱크 압력 스파이크, SIM-B 수소 누출 1차 경보 1회. 대조군 SIM-C에는 값을 바꾸는 시나리오를 넣지 않습니다.

**`verify:ingest` 검사 항목** (하나라도 실패하면 종료 코드 1)

- (a) 사이트별 `om.measurement` 행 수 = 적재 기록의 기대 고유 샘플 수 (미매핑 제외, 적재 샘플 시각 범위 안)
- (b) 남은 dirty를 모두 롤업한 뒤 `om.m_1h` 전체 = 원시 전체 재집계 (n·n_good·min·max·first·last 완전 일치, avg·sum 상대 오차 1e-9)
- (c) `om.unmapped_source`에 일부러 매핑하지 않은 태그만 있음
- (d) 보낸 critical 경보가 안전 이벤트(`is_safety`)로 기록됨
- (e) `CLOCK_SUSPECT` 샘플 수 = 시계 오차 배치의 기대 샘플 수, `LATE` 비트 존재

**알아 둘 점**

- 과거분을 지금 한꺼번에 보내므로 수신 시각보다 1시간 넘게 지난 샘플에는 모두 `LATE` 비트가 붙습니다(설계 §5.1 규칙 6). 그래서 `m_1h.n_good`(quality = 0 개수)은 거의 0입니다.
- 봉투의 `sent_at`은 실제 전송 시각으로 찍습니다. 따라서 `CLOCK_SUSPECT`는 시계 오차 구간의 배치에만 붙습니다.
- 같은 시간대에 같은 옵션으로 다시 실행하면 409(같은 `batch_id`에 `sent_at`만 다른 본문)가 나옵니다. 샘플은 이미 들어 있습니다. 다른 시각에 다시 실행하면 기간이 겹쳐 (a)가 맞지 않습니다. 처음부터 다시 만들려면 `npm run db:reset` → `npm run db:seed` → `npm run admin:create`(계정도 지워짐) 후 4~6단계를 반복하세요.
- 실시간 전송: `npm run sim:live -- --sites SIM-A,SIM-B,SIM-C` 는 현재 시각부터 5분 창마다 보냅니다(시나리오 없음, Ctrl+C로 종료). 설비 상태를 시작 시각으로 추정하므로 적재한 과거 데이터와 값이 이어지지는 않습니다.

### 테스트

테스트용 환경변수 파일을 한 번 만듭니다. `DATABASE_URL`의 DB 이름을 `hysol_test`로 바꾸고, `BETTER_AUTH_SECRET`·`INGEST_KEY_ENC_KEY`는 개발용과 다른 값, `E2E_ADMIN_PASSWORD`(12자 이상)를 채웁니다. E2E 브라우저도 한 번 설치합니다.

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
