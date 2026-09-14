import { describe, expect, it, vi } from 'vitest';
import { buildSslOptions } from './pool';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('buildSslOptions', () => {
  it('disable이면 false를 명시해 SSL을 끈다', () => {
    const readCaFile = vi.fn();

    expect(buildSslOptions({ DATABASE_SSL: 'disable', DATABASE_SSL_CA_PATH: undefined }, readCaFile)).toBe(false);
    expect(readCaFile).not.toHaveBeenCalled();
  });

  it('require면 암호화만 하고 인증서는 검증하지 않는다', () => {
    expect(buildSslOptions({ DATABASE_SSL: 'require', DATABASE_SSL_CA_PATH: undefined })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verify-full이면 CA 파일을 읽어 인증서를 검증한다', () => {
    const readCaFile = vi.fn(() => CA_PEM);

    const options = buildSslOptions({ DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_PATH: 'certs/rds.pem' }, readCaFile);

    expect(readCaFile).toHaveBeenCalledWith('certs/rds.pem');
    expect(options).toEqual({ ca: CA_PEM, rejectUnauthorized: true });
  });

  it('verify-full인데 CA 경로가 없으면 오류를 던진다', () => {
    expect(() => buildSslOptions({ DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_PATH: undefined })).toThrow(
      /DATABASE_SSL_CA_PATH가 필요합니다/,
    );
  });

  it('CA 파일을 읽지 못하면 경로와 원인을 담은 오류를 던진다', () => {
    const readCaFile = () => {
      throw new Error('ENOENT: no such file');
    };

    expect(() =>
      buildSslOptions({ DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_PATH: 'missing.pem' }, readCaFile),
    ).toThrow(/CA 번들을 읽지 못했습니다 \(missing\.pem\): ENOENT/);
  });
});
