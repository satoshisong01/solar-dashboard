import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeEncryptionKey, decryptGatewaySecret, encryptGatewaySecret } from './key-crypto';

const KEY = Buffer.alloc(32, 9);
const KEY_ID = 'gk_sim-b_dev';
const SECRET = 'dev-secret-하이솔-0123456789abcdef';

describe('decodeEncryptionKey', () => {
  it('base64 32바이트 키를 버퍼로 바꾼다', () => {
    const raw = randomBytes(32);

    expect(decodeEncryptionKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it.each([
    ['31바이트', Buffer.alloc(31, 1).toString('base64')],
    ['base64가 아닌 문자열', '!'.repeat(44)],
    ['hex', Buffer.alloc(32, 1).toString('hex')],
  ])('%s는 거부한다', (_label, value) => {
    expect(() => decodeEncryptionKey(value)).toThrow(/32바이트 키/);
  });
});

describe('encryptGatewaySecret / decryptGatewaySecret', () => {
  it('암호화한 값을 같은 키·key_id로 복호화하면 원래 비밀값이 나온다', () => {
    const blob = encryptGatewaySecret(SECRET, KEY, KEY_ID);

    expect(blob[0]).toBe(1);
    expect(blob.includes(Buffer.from(SECRET, 'utf8'))).toBe(false);
    expect(decryptGatewaySecret(blob, KEY, KEY_ID)).toBe(SECRET);
  });

  it('같은 비밀값도 매번 다른 IV로 다른 암호문이 된다', () => {
    const first = encryptGatewaySecret(SECRET, KEY, KEY_ID);
    const second = encryptGatewaySecret(SECRET, KEY, KEY_ID);

    expect(first.equals(second)).toBe(false);
  });

  it('다른 키로는 복호화할 수 없다', () => {
    const blob = encryptGatewaySecret(SECRET, KEY, KEY_ID);

    expect(() => decryptGatewaySecret(blob, Buffer.alloc(32, 8), KEY_ID)).toThrow(/복호화하지 못했습니다/);
  });

  it('다른 key_id 행에 옮겨 붙인 암호문은 복호화할 수 없다', () => {
    const blob = encryptGatewaySecret(SECRET, KEY, KEY_ID);

    expect(() => decryptGatewaySecret(blob, KEY, 'gk_sim-c_dev')).toThrow(/복호화하지 못했습니다/);
  });

  it('암호문이 1바이트라도 바뀌면 복호화할 수 없다', () => {
    const blob = encryptGatewaySecret(SECRET, KEY, KEY_ID);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decryptGatewaySecret(tampered, KEY, KEY_ID)).toThrow(/복호화하지 못했습니다/);
  });

  it('형식 버전이 다르거나 너무 짧으면 오류를 던진다', () => {
    const blob = encryptGatewaySecret(SECRET, KEY, KEY_ID);
    const wrongVersion = Buffer.concat([Buffer.from([2]), blob.subarray(1)]);

    expect(() => decryptGatewaySecret(wrongVersion, KEY, KEY_ID)).toThrow(/버전 2/);
    expect(() => decryptGatewaySecret(blob.subarray(0, 29), KEY, KEY_ID)).toThrow(/길이/);
  });

  it('키 길이가 32바이트가 아니거나 비밀값이 비어 있으면 거부한다', () => {
    expect(() => encryptGatewaySecret(SECRET, Buffer.alloc(16), KEY_ID)).toThrow(/32바이트/);
    expect(() => encryptGatewaySecret('', KEY, KEY_ID)).toThrow(/비어 있습니다/);
  });
});
