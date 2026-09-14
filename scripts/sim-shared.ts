// sim:backfill · sim:live 공용 도우미 (인자 검증, 게이트웨이 키 읽기, 서버 확인, 출력 형식).
// 게이트웨이 비밀값은 npm 스크립트가 dotenv로 넣은 .env.development.local의 SIM_GATEWAY_SECRET_*만 읽고 출력하지 않는다.
import { SIM_SITES } from '../db/seed/sites';
import { INGEST_PATH, type GatewayCredential } from '../lib/sim/emit-http';
import { KST_OFFSET_MS } from '../lib/sim/math';

export function parseIntegerOption(name: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name}은(는) ${min}~${max} 사이의 정수여야 합니다 (받은 값: ${raw ?? '없음'})`);
  return value;
}

export function parseSiteCodes(raw: string | undefined): readonly string[] {
  const codes = (raw ?? '').split(',').map((code) => code.trim()).filter(Boolean);
  const known = new Set(SIM_SITES.map((site) => site.code));
  const unknown = codes.filter((code) => !known.has(code));
  if (codes.length === 0 || unknown.length > 0 || new Set(codes).size !== codes.length) {
    throw new Error(`--sites는 ${[...known].join(',')} 중 중복 없는 쉼표 목록이어야 합니다 (받은 값: ${raw ?? '없음'})`);
  }
  return codes;
}

export function parseBaseUrl(raw: string | undefined): string {
  if (!raw || !URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) throw new Error(`--base-url은 http(s):// URL이어야 합니다 (받은 값: ${raw ?? '없음'})`);
  return raw;
}

/** 게이트웨이 코드 → 키 ID·비밀값. 빠진 환경변수 이름만 알려 준다. */
export function loadGatewayCredentials(siteCodes: readonly string[]): ReadonlyMap<string, GatewayCredential> {
  const sites = SIM_SITES.filter((site) => siteCodes.includes(site.code));
  const missing = sites.filter(({ gateway }) => !process.env[gateway.secretEnvVar]).map(({ gateway }) => gateway.secretEnvVar);
  if (missing.length > 0) {
    throw new Error(`.env.development.local에 ${missing.join(', ')}이(가) 없습니다. 먼저 npm run db:seed 를 실행하세요.`);
  }
  return new Map(sites.map(({ gateway }) => [gateway.code, { keyId: gateway.keyId, secret: process.env[gateway.secretEnvVar] ?? '' }]));
}

/** 수집 라우트가 떠 있는지 확인한다 (GET은 405). */
export async function assertIngestReachable(baseUrl: string): Promise<void> {
  const url = new URL(INGEST_PATH, baseUrl).toString();
  let status: number;
  try {
    status = (await fetch(url, { method: 'GET', signal: AbortSignal.timeout(60_000) })).status;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${url}에 연결할 수 없습니다 (${reason}). 먼저 npm run dev 로 서버를 켜세요.`);
  }
  if (status !== 405) throw new Error(`${url}이 수집 API가 아닌 것 같습니다 (GET 응답 ${status}, 기대 405)`);
}

export const formatCount = (n: number): string => n.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  const totalS = Math.round(ms / 1_000);
  const minutes = Math.floor(totalS / 60);
  return minutes > 0 ? `${minutes}분 ${totalS % 60}초` : `${totalS}초`;
}

/** 'YYYY-MM-DD HH:mm KST' */
export function formatKst(ms: number): string {
  return `${new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} KST`;
}
