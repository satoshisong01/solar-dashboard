// 게이트웨이 HMAC 비밀값을 om.gateway_key.secret_enc에 저장하기 위한 AES-256-GCM 암·복호화.
// 'server-only'를 넣지 않는다: 시드 스크립트(tsx)와 테스트에서도 쓴다.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** INGEST_KEY_ENC_KEY(base64)를 32바이트 키로 바꾼다. */
export function decodeEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== base64Key) {
    throw new Error('INGEST_KEY_ENC_KEY는 base64로 인코딩한 32바이트 키여야 합니다');
  }
  return key;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new Error(`암호화 키는 ${KEY_BYTES}바이트여야 합니다`);
}

/**
 * 형식: [버전 1B][IV 12B][인증 태그 16B][암호문].
 * key_id를 AAD로 묶어, 다른 키 행에 암호문을 옮겨 붙이면 복호화가 실패하게 한다.
 */
export function encryptGatewaySecret(secret: string, key: Uint8Array, keyId: string): Buffer {
  assertKey(key);
  if (secret.length === 0) throw new Error('게이트웨이 비밀값이 비어 있습니다');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** 키가 다르거나, key_id가 다르거나, 암호문이 변조됐으면 오류를 던진다. */
export function decryptGatewaySecret(blob: Uint8Array, key: Uint8Array, keyId: string): string {
  assertKey(key);
  const data = Buffer.from(blob);
  if (data.length <= HEADER_BYTES) throw new Error('암호문 길이가 올바르지 않습니다');
  if (data[0] !== FORMAT_VERSION) throw new Error(`지원하지 않는 암호문 형식입니다 (버전 ${data[0]})`);

  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(keyId, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`게이트웨이 키(${keyId})를 복호화하지 못했습니다. INGEST_KEY_ENC_KEY가 저장 당시와 같은지 확인하세요.`);
  }
}
