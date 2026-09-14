import { describe, expect, it } from 'vitest';
import { parseAckForm, parseAdminForm, parseGatewayForm, parseGatewayIdForm, parseKeyIdForm, parseMarketManualForm } from './settings';

describe('parseGatewayForm', () => {
  it('코드를 대문자로 바꿔 받는다', () => {
    expect(parseGatewayForm({ siteId: '2', code: ' gw-simb-02 ' })).toEqual({ ok: true, input: { siteId: 2, code: 'GW-SIMB-02' } });
  });

  it.each(['G', '-GW', 'GW_01', 'GW 01', `G${'W'.repeat(64)}`])('코드 규칙 위반: %s', (code) => {
    expect(parseGatewayForm({ siteId: '1', code })).toMatchObject({ ok: false, fieldErrors: { code: expect.any(String) } });
  });

  it('사이트를 고르지 않으면 오류', () => {
    expect(parseGatewayForm({ code: 'GW-01' })).toEqual({ ok: false, fieldErrors: { siteId: '사이트를 고르세요' } });
  });
});

describe('parseKeyIdForm', () => {
  it('키 ID 형식만 허용한다', () => {
    expect(parseKeyIdForm({ keyId: 'gk_sim-b_dev' })).toEqual({ ok: true, input: { keyId: 'gk_sim-b_dev' } });
    expect(parseKeyIdForm({ keyId: 'gk sim' }).ok).toBe(false);
  });
});

describe('parseAdminForm', () => {
  it('이메일은 소문자로, 이름은 공백 제거, 비밀번호는 그대로', () => {
    expect(parseAdminForm({ email: ' Ops@HySol.local ', name: ' 운영자 ', password: ' 12345678901 ' })).toEqual({
      ok: true,
      input: { email: 'ops@hysol.local', name: '운영자', password: ' 12345678901 ' },
    });
  });

  it('임시 비밀번호는 12자 이상, 이메일 형식 확인', () => {
    expect(parseAdminForm({ email: 'ops', name: '운영자', password: 'short' })).toEqual({
      ok: false,
      fieldErrors: { email: '올바른 이메일이 아닙니다', password: '임시 비밀번호는 12자 이상입니다' },
    });
  });
});

describe('parseAckForm', () => {
  it('메모는 필수이고 공백만 있으면 안 된다', () => {
    expect(parseAckForm({ eventId: '451', note: '  현장 확인, 오경보  ' })).toEqual({ ok: true, input: { eventId: '451', note: '현장 확인, 오경보' } });
    expect(parseAckForm({ eventId: '451', note: '   ' })).toEqual({ ok: false, fieldErrors: { note: '확인 메모를 입력하세요' } });
  });

  it('이벤트 id는 양의 정수 문자열', () => {
    expect(parseAckForm({ eventId: '0', note: 'x' }).ok).toBe(false);
    expect(parseAckForm({ eventId: '12a', note: 'x' }).ok).toBe(false);
  });
});

describe('parseMarketManualForm', () => {
  it('입력한 항목만 행으로 만든다', () => {
    expect(parseMarketManualForm({ day: '2026-09-14', smp_land: '142.5', smp_jeju: '', rec_avg: '71500' })).toEqual({
      ok: true,
      input: [
        { day: '2026-09-14', marketKey: 'smp_land', value: 142.5 },
        { day: '2026-09-14', marketKey: 'rec_avg', value: 71500 },
      ],
    });
  });

  it('값이 하나도 없으면 폼 전체 오류, 날짜·값 형식 오류는 필드별', () => {
    expect(parseMarketManualForm({ day: '2026-09-14' })).toEqual({ ok: false, fieldErrors: { '': '값을 한 항목 이상 입력하세요' } });
    expect(parseMarketManualForm({ day: '2026-13-01', smp_jeju: 'abc' })).toEqual({
      ok: false,
      fieldErrors: { day: '달력에 없는 날짜입니다', smp_jeju: '값은 숫자여야 합니다 (천 단위 쉼표 없이)' },
    });
  });
});

describe('smallint·bigint id 범위', () => {
  it('사이트·게이트웨이 id는 smallint 상한(32767)까지만', () => {
    expect(parseGatewayForm({ siteId: '32767', code: 'GW-01' }).ok).toBe(true);
    expect(parseGatewayForm({ siteId: '32768', code: 'GW-01' })).toEqual({ ok: false, fieldErrors: { siteId: '사이트를 고르세요' } });
    expect(parseGatewayIdForm({ gatewayId: '3' })).toEqual({ ok: true, input: { gatewayId: 3 } });
    expect(parseGatewayIdForm({ gatewayId: '99999' }).ok).toBe(false);
  });

  it('이벤트 id는 18자리까지 (bigint 범위)', () => {
    expect(parseAckForm({ eventId: '9'.repeat(18), note: 'x' }).ok).toBe(true);
    expect(parseAckForm({ eventId: '9'.repeat(19), note: 'x' }).ok).toBe(false);
  });
});
