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
   - `om.asset_class`·`om.metric_def` 카탈로그와 가상 사이트 SIM-A(태양광+ESS)·SIM-B(연계형)·SIM-C(연계형 대조군)의 설비 트리·게이트웨이·포인트 매핑을 upsert합니다. 여러 번 실행해도 결과가 같고, 이미 있는 설비·포인트는 UPDATE만 해서 id 시퀀스도 늘지 않습니다.
   - 게이트웨이 개발용 HMAC 비밀값 `SIM_GATEWAY_SECRET_<게이트웨이 코드>`가 env 파일에 없으면 생성해 파일 끝에 추가하고, DB에는 `INGEST_KEY_ENC_KEY`로 암호화해 저장합니다. 이미 저장된 키는 현재 `INGEST_KEY_ENC_KEY`로 풀리고 비밀값이 같으면 다시 암호화하지 않습니다(키를 바꿨거나 비밀값이 달라졌을 때만 다시 암호화). 비밀값은 출력하지 않습니다.
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
| `db:migrate` / `db:migrate:down` | 개발 DB에 남은 마이그레이션 전부 적용 / 마지막 1개 되돌리기. `scripts/db-migrate.ts`가 node-pg-migrate를 실행하며 `DATABASE_SSL`·`DATABASE_SSL_CA_PATH`를 앱과 같은 규칙으로 반영한다. 개수 지정: `npm run db:migrate:down -- 2` |
| `db:migrate:test` | 테스트 DB 마이그레이션 (integration·e2e가 시작할 때 같은 작업을 자동으로 한다) |
| `db:types` | DB에서 `lib/db/types.ts` 생성 (om, public, sim 스키마. 파티션 자식 테이블은 제외) |
| `db:seed` / `db:seed:test` | 개발 / 테스트 DB에 카탈로그·가상 사이트 멱등 upsert. 게이트웨이 개발용 비밀값이 없으면 해당 env 파일에 생성 |
| `db:reset` | **로컬 전용.** 개발 DB 스키마를 모두 지우고 다시 migrate. `localhost:54320`이 아니면 중단 |
| `db:rollup:rebuild` | **로컬 전용.** `om.m_1h`를 원시 측정값에서 UTC 하루 단위로 전부 다시 집계한다(롤업 규칙이 바뀐 뒤 과거분을 맞출 때). 끝나면 `n_good/n` 비율을 출력. `localhost:54320`이 아니면 중단 |
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

- 과거분을 지금 한꺼번에 보내므로 수신 시각보다 1시간 넘게 지난 샘플에는 모두 `LATE` 비트가 붙습니다(설계 §5.1 규칙 6). 품질 비트는 두 종류입니다.
  - **BAD**(`DEVICE_BAD`·`HARD_RANGE`·`SPIKE`·`FLATLINE`): 값을 믿을 수 없음. `m_1h.n_good`에서 빠집니다.
  - **INFO**(`CLOCK_SUSPECT`·`LATE`·`REPROCESSED`): 값은 유효하고 수신·출처 상태만 표시. `n_good`에 포함됩니다. 시각 정확도가 중요한 분석은 `isGoodWithTrustedClock`으로 `CLOCK_SUSPECT`까지 뺄 수 있습니다(`lib/ingest/quality.ts`).
  - `n_good` = 값이 NULL이 아니고 BAD 비트가 없는 샘플 수입니다. 이 규칙 이전에 적재한 개발 DB는 `npm run db:rollup:rebuild`로 `m_1h`를 다시 집계하세요.
- 봉투 본문은 시뮬레이터가 만든 그대로 보냅니다(`sent_at` = 시뮬레이션 배치 전송 시각). 서버는 `sent_at`이 아니라 **서명 시각(`X-OM-Timestamp`)과 수신 시각의 차이**로 시계 오차를 재므로(재전송 본문의 `sent_at`은 오래될 수 있음), `CLOCK_SUSPECT`는 시계 오차 구간의 배치에만 붙습니다.
- 같은 시간대(같은 적재 창)에 같은 시드·옵션으로 다시 실행하면 본문이 같아 모든 배치가 200 duplicate가 되고 원시는 늘지 않습니다. 이 방식 이전 전송기(`sent_at`을 전송 시각으로 바꿔 보냄)로 적재한 데이터에 다시 보내면 409가 날 수 있습니다(샘플은 이미 들어 있음). 다른 시각에 다시 실행하면 기간이 겹쳐 (a)가 맞지 않습니다. 처음부터 다시 만들려면 `npm run db:reset` → `npm run db:seed` → `npm run admin:create`(계정도 지워짐) 후 4~6단계를 반복하세요.
- 실시간 전송: `npm run sim:live -- --sites SIM-A,SIM-B,SIM-C` 는 현재 시각부터 5분 창마다 보냅니다(시나리오 없음, Ctrl+C로 종료). 설비 상태를 시작 시각으로 추정하므로 적재한 과거 데이터와 값이 이어지지는 않습니다.

### 분석 실행 (`lib/analysis`)

분석은 **수동 실행만** 있습니다(설계 §0). 관리자가 사이트·설비·기간을 고르면 `runAnalysis(db, { siteIds, assetIds?, from, to, requestedBy })`가 결과를 발견사항(finding)으로만 저장하고, 리포트는 만들지 않습니다. 콘솔 버튼(다음 단계)과 로컬 확인용 CLI가 같은 함수를 씁니다.

```bash
npm run analyze -- --sites SIM-A,SIM-B,SIM-C --days 120        # 끝 시각 기본값 = 지금
npm run analyze -- --sites SIM-B --days 30 --to 2026-09-15T00:00:00+09:00 --assets 57,58 --budget-min 10
```

1. `om.analysis_run` 행을 만들고, 전용 연결의 트랜잭션에서 사이트 id 순서대로 `pg_try_advisory_xact_lock(hashtext('om.analysis_run'), site_id)`를 잡습니다. 하나라도 못 잡으면 실행 행을 `failed`로 남기고 거절합니다(`AnalysisBusyError`). 잡은 뒤 같은 사이트를 포함한 채 `running`으로 남은 이전 실행은 중단된 실행으로 보고 `failed`로 정리합니다.
2. 대상 사이트 포인트의 남은 dirty 롤업을 처리합니다.
3. 설비별 에피소드 추출: `[from − 6시간의 KST 0시, to)`(앞 실행이 끝에 걸려 `open`으로 저장한 에피소드가 있으면 그 시작부터)를 다시 뽑아, 그 구간의 기존 에피소드를 지우고 새로 넣습니다.
4. `om.kpi_daily` upsert (인버터 발전량·비발전량·동종 비율·가용률, 사이트 합계, 랙 왕복효율, 전해조 SEC, 연료전지 원단위·기준 전류밀도 전압).
5. 탐지기 6종: 저장된 에피소드 전체 이력(기준선부터)과 `om.asset_event`(설비·상위 설비, `resets_baseline` 반영), 활성 `om.detector_config`(default < class < asset)로 `lib/analytics/pipeline`이 입력을 조립합니다. `dq.gap_flatline`은 1시간 롤업 공백과 원시 고착 구간을 SQL로 요약합니다(사이트에 데이터가 있는 구간만). 용량 감소 finding이 나면 대표 세션 충전 곡선을 읽어 오버레이를 채웁니다.
6. finding upsert: `dedup_key = 탐지기|설비|고장모드`. 열린 건은 갱신(`last_detected_at`·`detection_count`·심각도·신뢰도·효과, 조치 이후 악화면 system이 `reopened`), 없으면 억제 기간 안의 기각 건이면 건너뛰고 아니면 새로 만듭니다(닫힌 이전 건은 `previous_finding_id`). 근거는 매번 `finding_evidence`에 추가합니다(`input_hash`).
7. 조치 효과 검증: 후 창(`performed_at + stabilization_days`부터 `window_days`, 기본 30일)이 `to`까지 채워진 정비 조치를 `matched_before_after@1`로 비교해 `om.action_verification`에 upsert하고, `improved`이면 연결 발견사항을 system이 `verified`로 옮깁니다.
8. 설비·탐지기 단위 오류와 시간 예산(기본 15분) 초과는 기록하고 계속해 `partial`, 실행 전체가 실패하면 `failed`로 끝납니다. `stats`에 사이트별 설비·에피소드·KPI 행·탐지기별 ok/부족/오류/finding·finding 생성·갱신·억제·재발·검증 결과·소요시간이 남습니다.

상태 전이(`lib/analysis/transitions.ts`, 규칙은 `transition-rules.ts`): `triageFinding`(new·reopened → triaged), `dismissFinding`(사유 필수, 억제 기간, 사유가 '운영 조건 변경'이면 `resetBaseline`으로 기준선 분할 `asset_event` 생성), `reopenFinding`, `markFindingsInReport`(리포트 승인 시), `registerMaintenanceAction`(조치 기록 + `action_taken`). `verified`는 조치 검증(system)만 기록합니다.

### 시뮬레이터 평가 게이트 (`sim:eval`)

DB·서버 없이 메모리 모드로 1년치 가상 데이터를 만들어 탐지기 성능을 재고, 설계 §5.5 CI 게이트를 판정합니다. 에피소드 추출·탐지기 입력 조립은 분석 실행(`lib/analysis`)과 같은 `lib/analytics/pipeline` 함수를 씁니다.

```bash
npm run sim:eval                                  # 전체: 시드 3 × 크기 스윕 5 (사이트 잡 33개)
npm run sim:eval -- --seeds 101 --runs 3,4        # CI 축소: 시드 101의 스윕 3·4번(용량 5·7%, 전해조 20·40 µV/h)
npm run sim:eval -- --cache .data/sim-eval        # 시뮬레이션·추출 결과를 저장해 두고 탐지기 파라미터만 바꿔 다시 평가
```

- 프리셋은 `lib/sim/presets.ts`의 `EVAL_PRESET`(2025-10-01부터 365일, 고장은 120일째 시작, 용량 감소는 30일에 걸쳐 진행)입니다. 사이트마다 난수·플랜트가 독립이라 같은 시드·시나리오인 사이트는 한 번만 시뮬레이션합니다(대조군 SIM-C는 시드당 1회).
- 잡은 자식 프로세스 N개(`--concurrency`, 기본 min(8, CPU−1))로 나눠 돌립니다. 이 PC(16코어)에서 전체 약 3분 30초, 시드 1개·스윕 2개 축소는 약 1분입니다.
- 주 단위 점검 시각마다 탐지기를 실행하고, 주입 설비는 하루 단위로 첫 탐지를 좁힙니다. 판정 규칙은 `lib/sim/eval/score.ts` 머리 주석에 있습니다: TP = 주입 설비·기대 고장모드 finding이 주입 시작~종료+7일에 나옴, FP = 그 밖의 finding(연속 점검은 한 건), 크기 오차 = 마지막 탐지 효과와 같은 창의 참값 차이(용량은 시뮬레이터 참 SOH 비율).
- 게이트: `ess.capacity_fade` 5% 이상 재현율 ≥ 0.9·크기 MAE ≤ 1%p·지연 중앙값 ≤ 21일 / 5종 오탐 ≤ 0.1건/자산·월 / `el.voltage_rise` 20 µV/h 이상 재현율 ≥ 0.9. 하나라도 미달이면 종료 코드 1입니다. 평가할 주입이 없으면(축소 선택에서 빠짐) 미달로 봅니다.
- `dq.gap_flatline`은 메모리 모드가 전송 계층(단절·지연·시계 오차)을 재현하지 않아 평가하지 않습니다.
- 전체 프리셋이면 `lib/analytics/scorecard.json`(탐지기별 재현율·정밀도·오탐률·지연·크기 오차·최소 탐지 크기 곡선, 게이트, 파라미터 조정 내역)을 갱신합니다. 일부만 돌리면 `--out`을 준 경우에만 씁니다. `npm run db:up`으로 로컬 DB가 떠 있으면 `sim.run`·`sim.injection`·`sim.eval_result`에도 기록합니다(`--no-db`로 끔).

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
| `npm run test:e2e` | Playwright (`tests/e2e`, chromium). `next build` 후 `next start -p 3100`을 띄우고, 테스트 DB 초기화(마이그레이션 down → up)·시드·테스트 관리자(`e2e-admin@hysol.local`) 생성, SIM-B 최근 2일을 실제 수집 API로 적재한 뒤 실행. 끝나면 테스트 DB를 migrate·seed 직후 상태로 되돌린다 |
| `npm run test:all` | unit → integration → e2e 순서로 모두 실행 |
| `npx vitest run --project unit --coverage` | `lib/**` 커버리지 (`coverage/`) |

integration과 e2e는 둘 다 테스트 DB의 마이그레이션을 모두 되돌렸다가 다시 적용하므로 동시에 실행하지 마세요. e2e가 끝난 테스트 DB에는 수집 데이터·테스트 계정이 남지 않습니다.

## 인증

Better Auth(이메일+비밀번호, 가입 비활성, admin 플러그인, DB 세션·rate limit)를 씁니다. 테이블은 `auth_*`이고 `db/migrations`로만 관리합니다(`auth migrate`를 직접 실행하지 않음).

- `proxy.ts`는 세션 쿠키가 있는지만 보고 없으면 `/login`으로 보냅니다.
- 실제 검사는 `lib/auth/dal.ts`의 `requireAdmin()`입니다. 콘솔의 모든 page, Server Action, Route Handler 첫 줄에서 호출합니다.
- 로그인은 브라우저에서 `/api/auth/sign-in/email`로 보냅니다. 서버의 `auth.api.*` 호출에는 rate limit이 적용되지 않기 때문입니다.

새 마이그레이션은 SQL 파일로 만듭니다.

```bash
npx node-pg-migrate create <이름> -j sql -m db/migrations --migration-filename-format utc
```

## 운영 RDS에 마이그레이션 적용

`npm run db:migrate`는 `.env.development.local`(로컬 DB)을 읽으므로 운영에는 쓰지 않습니다. `.env.local`의 옛 `DB_*` 변수는 읽지 않습니다. 운영용 env 파일을 따로 만들어(`.env*`는 git에 올라가지 않음, 예: `.env.rds.local`) 같은 스크립트를 실행합니다.

1. RDS CA 번들을 받습니다: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
2. env 파일에 연결 정보만 넣습니다 (마이그레이션은 인증·수집 비밀값이 필요 없습니다).
   ```bash
   DATABASE_URL=postgres://<user>:<password>@<rds-endpoint>:5432/<db>
   DATABASE_SSL=verify-full
   DATABASE_SSL_CA_PATH=<global-bundle.pem 경로>
   ```
3. 적용합니다. 셸에 `DATABASE_URL`이 남아 있으면 dotenv가 파일 값을 덮어쓰지 않으니 먼저 지우세요.
   ```bash
   npx dotenv -e .env.rds.local -- tsx scripts/db-migrate.ts up
   ```
   - 시작 줄에 접속 대상(비밀번호 제외)과 SSL 모드가 나옵니다. `verify-full`이면 CA 번들로 인증서 체인과 호스트 이름을 검증하고, CA 경로가 없거나 파일을 읽지 못하면 접속 전에 중단합니다.
   - `require`는 인증서를 검증하지 않아 운영에는 쓰지 않습니다.
   - 되돌리기: `... tsx scripts/db-migrate.ts down [개수]` (기본 1개)
4. `sim` 스키마 마이그레이션(`*_sim-eval-schema.sql`)은 시뮬레이터 평가용이라 앱이 참조하지 않지만, 적용 순서 검사 때문에 건너뛰지 말고 함께 적용합니다(빈 테이블만 생깁니다).
