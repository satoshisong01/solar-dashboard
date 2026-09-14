-- Up Migration
-- Better Auth 1.7.4 테이블 (lib/auth/create-auth.ts의 modelName과 일치).
-- Better Auth getMigrations 출력(= auth generate, kysely)을 그대로 옮겼다. 컬럼명은 Better Auth 기본값인 camelCase.
CREATE TABLE "auth_user" (
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

CREATE TABLE "auth_session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  -- admin 플러그인
  "impersonatedBy" text
);

CREATE TABLE "auth_account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
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

CREATE TABLE "auth_verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- rateLimit.storage = 'database'
CREATE TABLE "auth_rate_limit" (
  "id" text NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

CREATE INDEX "auth_session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" ON "auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");

-- Down Migration
DROP TABLE IF EXISTS "auth_rate_limit";
DROP TABLE IF EXISTS "auth_verification";
DROP TABLE IF EXISTS "auth_account";
DROP TABLE IF EXISTS "auth_session";
DROP TABLE IF EXISTS "auth_user";
