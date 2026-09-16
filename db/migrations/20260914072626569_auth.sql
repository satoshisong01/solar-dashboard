-- Up Migration
-- Better Auth 1.7.4 테이블 (lib/auth/create-auth.ts의 modelName과 일치).
-- Better Auth getMigrations 출력(= auth generate, kysely)을 그대로 옮겼다. 컬럼명은 Better Auth 기본값인 camelCase.
-- 운영 DB는 여러 프로젝트가 public 스키마를 공유하므로 우리 테이블은 전부 om 스키마에만 만든다.
-- Better Auth 어댑터는 테이블 이름을 스키마 없이 쓰므로 앱 풀이 search_path=om,public로 연결한다 (lib/db/pool.ts).
CREATE TABLE om."auth_user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  -- admin 플러그인
  "role" text,
  "banned" boolean,
  "banReason" text,
  "banExpires" timestamptz
);

CREATE TABLE om."auth_session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES om."auth_user" ("id") ON DELETE CASCADE,
  -- admin 플러그인
  "impersonatedBy" text
);

CREATE TABLE om."auth_account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES om."auth_user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE om."auth_verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- rateLimit.storage = 'database'
CREATE TABLE om."auth_rate_limit" (
  "id" text NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

CREATE INDEX "auth_session_userId_idx" ON om."auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" ON om."auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" ON om."auth_verification" ("identifier");

-- Down Migration
DROP TABLE IF EXISTS om."auth_rate_limit";
DROP TABLE IF EXISTS om."auth_verification";
DROP TABLE IF EXISTS om."auth_account";
DROP TABLE IF EXISTS om."auth_session";
DROP TABLE IF EXISTS om."auth_user";
