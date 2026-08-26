import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { checkAuth, clientIpOf, extractBearer, safeCompare } from '../src/auth.js';

const KEY = 'a'.repeat(64);

function fakeRequest(headers: Record<string, string | string[]> = {}, remote = '127.0.0.1'): Request {
  return { headers, socket: { remoteAddress: remote } } as unknown as Request;
}

describe('extractBearer', () => {
  it('lê o token do header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
  });

  it('aceita o esquema em qualquer caixa', () => {
    expect(extractBearer('bearer abc123')).toBe('abc123');
  });

  it('recusa headers sem Bearer', () => {
    expect(extractBearer('Basic abc123')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Bearer   ')).toBeNull();
  });
});

describe('safeCompare', () => {
  it('aceita tokens iguais', () => {
    expect(safeCompare(KEY, KEY)).toBe(true);
  });

  it('recusa tokens diferentes do mesmo tamanho', () => {
    expect(safeCompare('b'.repeat(64), KEY)).toBe(false);
  });

  it('recusa tokens de tamanhos diferentes sem lançar', () => {
    expect(safeCompare('curto', KEY)).toBe(false);
  });
});

describe('checkAuth', () => {
  it('exige o header Authorization', () => {
    const outcome = checkAuth(fakeRequest(), KEY, []);
    expect(outcome).toMatchObject({ ok: false, status: 401, code: 'MISSING_TOKEN' });
  });

  it('recusa token inválido com 403', () => {
    const outcome = checkAuth(fakeRequest({ authorization: 'Bearer errado' }), KEY, []);
    expect(outcome).toMatchObject({ ok: false, status: 403, code: 'INVALID_TOKEN' });
  });

  it('aceita o token correto', () => {
    expect(checkAuth(fakeRequest({ authorization: `Bearer ${KEY}` }), KEY, [])).toEqual({ ok: true });
  });

  it('aplica a allowlist de IP quando configurada', () => {
    const req = fakeRequest({ authorization: `Bearer ${KEY}`, 'x-forwarded-for': '203.0.113.10' });
    expect(checkAuth(req, KEY, ['203.0.113.10'])).toEqual({ ok: true });
    expect(checkAuth(req, KEY, ['198.51.100.7'])).toMatchObject({
      ok: false,
      status: 403,
      code: 'IP_NOT_ALLOWED',
    });
  });

  it('ignora a allowlist quando vazia', () => {
    const req = fakeRequest({ authorization: `Bearer ${KEY}`, 'x-forwarded-for': '203.0.113.10' });
    expect(checkAuth(req, KEY, [])).toEqual({ ok: true });
  });
});

describe('clientIpOf', () => {
  it('prefere X-Real-IP, que o nginx sobrescreve', () => {
    expect(clientIpOf(fakeRequest({ 'x-real-ip': '203.0.113.10' }))).toBe('203.0.113.10');
  });

  it('usa o ÚLTIMO item de X-Forwarded-For, o que o nginx acrescentou', () => {
    expect(clientIpOf(fakeRequest({ 'x-forwarded-for': '203.0.113.10, 198.51.100.7' }))).toBe(
      '198.51.100.7'
    );
  });

  it('cai para o socket quando não há proxy', () => {
    expect(clientIpOf(fakeRequest({}, '198.51.100.2'))).toBe('198.51.100.2');
  });
});

describe('allowlist não pode ser furada por header forjado', () => {
  const PERMITIDO = '169.58.161.112';

  it('ignora um X-Forwarded-For forjado pelo cliente', () => {
    // O nginx entrega "<valor forjado>, <ip real>": o real é sempre o último.
    const req = fakeRequest({
      authorization: `Bearer ${KEY}`,
      'x-forwarded-for': `${PERMITIDO}, 45.33.32.156`,
    });
    expect(checkAuth(req, KEY, [PERMITIDO])).toMatchObject({
      ok: false,
      status: 403,
      code: 'IP_NOT_ALLOWED',
    });
  });

  it('ignora X-Forwarded-For forjado quando o nginx mandou X-Real-IP', () => {
    const req = fakeRequest({
      authorization: `Bearer ${KEY}`,
      'x-forwarded-for': PERMITIDO,
      'x-real-ip': '45.33.32.156',
    });
    expect(checkAuth(req, KEY, [PERMITIDO])).toMatchObject({ ok: false, status: 403 });
  });

  it('aceita a origem legítima', () => {
    const req = fakeRequest({ authorization: `Bearer ${KEY}`, 'x-real-ip': PERMITIDO });
    expect(checkAuth(req, KEY, [PERMITIDO])).toEqual({ ok: true });
  });
});
