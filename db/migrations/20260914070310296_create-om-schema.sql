-- Up Migration
-- 운영 DB의 public 스키마는 다른 프로젝트와 공유하므로 우리 객체는 전부 om(·sim) 안에만 만든다.
-- lib/db/migrate.ts가 실행 전에 om을 만들고 search_path도 om으로 두지만, CLI로 직접 돌릴 때를 위해 여기서도 만든다.
CREATE SCHEMA IF NOT EXISTS om;

-- Down Migration
-- om 스키마 자체는 지우지 않는다: 마이그레이션 기록 테이블 om.pgmigrations가 이 안에 있어
-- 여기서 DROP SCHEMA를 하면 같은 트랜잭션의 기록 삭제가 실패한다.
-- 스키마 정리는 마이그레이션 밖에서 한다 (로컬은 npm run db:reset).
