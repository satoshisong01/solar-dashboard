# HySol Desk

태양광·ESS·수전해·수소저장·연료전지 설비의 원시데이터를 분석해 사이트별 유지보수 코칭까지 잇는 관리자 전용 O&M 분석 콘솔입니다.

- 설계 문서: [docs/renewal/README.md](docs/renewal/README.md)

## 로컬 개발

로컬 DB는 Docker 없이 [embedded-postgres](https://github.com/leinelissen/embedded-postgres)로 PostgreSQL 17을 일반 프로세스로 띄웁니다. 관리자 권한이 아닌 일반 셸에서 실행하세요.

```bash
npm install
cp .env.example .env.development.local   # DATABASE_URL …/hysol
cp .env.example .env.test.local          # DB 이름만 hysol_test 로 수정
```

**터미널 1** — DB 서버를 켜 두기 (데이터: `.data/pg`, 포트 54320, 최초 실행 시 `hysol`·`hysol_test` DB 생성)

```bash
npm run db:up      # Ctrl+C로 종료
```

**터미널 2**

```bash
npm run db:migrate        # 개발 DB 마이그레이션
npm run db:migrate:test   # 테스트 DB 마이그레이션
npm run db:types          # DB에서 lib/db/types.ts 생성 (om, public 스키마)
npm run dev
npm run db:down           # 서버 종료 (터미널 1을 닫지 못할 때)
```

| 스크립트 | 설명 |
|---|---|
| `db:migrate:down` | 마지막 마이그레이션 1개 되돌리기 |
| `db:reset` | **로컬 전용.** 개발 DB 스키마를 모두 지우고 다시 migrate. `localhost:54320`이 아니면 중단 |

새 마이그레이션은 SQL 파일로 만듭니다.

```bash
npx node-pg-migrate create <이름> -j sql -m db/migrations --migration-filename-format utc
```
