import { describe, expect, it, vi } from 'vitest';
import {
  buildPath,
  buildQuery,
  FamachatApiError,
  FamachatClient,
  WILDCARD_PARAM,
} from '../src/famachat/client.js';

const CONFIG = {
  FAMACHAT_API_URL: 'http://backend.test',
  FAMACHAT_SERVICE_EMAIL: 'hermes-agent@famachat.com.br',
  FAMACHAT_SERVICE_PASSWORD: 'senha',
  FAMACHAT_REQUEST_TIMEOUT_MS: 5000,
  FAMACHAT_MAX_RESPONSE_BYTES: 1_048_576,
};

/** JWT sem assinatura válida — só o `exp` importa para o agendamento da renovação. */
function fakeJwt(expiresInSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ id: 1, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
  ).toString('base64url');
  return `header.${payload}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildPath', () => {
  it('substitui os parâmetros de rota', () => {
    expect(buildPath('/api/clientes/:id/notes', { id: 42 })).toBe('/api/clientes/42/notes');
  });

  it('codifica valores', () => {
    expect(buildPath('/api/x/:nome', { nome: 'a b/c' })).toBe('/api/x/a%20b%2Fc');
  });

  it('reclama de parâmetro ausente', () => {
    expect(() => buildPath('/api/clientes/:id', {})).toThrow(FamachatApiError);
  });

  it('remove o segmento inteiro quando um parâmetro opcional não vem', () => {
    expect(buildPath('/api/rate-limit/reset/:userId?', {})).toBe('/api/rate-limit/reset');
  });

  it('preenche o parâmetro opcional quando ele vem', () => {
    expect(buildPath('/api/rate-limit/reset/:userId?', { userId: 9 })).toBe(
      '/api/rate-limit/reset/9'
    );
  });

  it('substitui o wildcard preservando as barras do caminho', () => {
    expect(buildPath('/api/storage/files/*', { [WILDCARD_PARAM]: 'pasta/nota fiscal.pdf' })).toBe(
      '/api/storage/files/pasta/nota%20fiscal.pdf'
    );
  });

  it('reclama de wildcard ausente', () => {
    expect(() => buildPath('/api/storage/files/*', {})).toThrow(FamachatApiError);
  });
});

describe('buildQuery', () => {
  it('serializa valores simples', () => {
    expect(buildQuery({ limit: 20, status: 'Novo' })).toBe('?limit=20&status=Novo');
  });

  it('repete a chave para arrays e ignora nulos', () => {
    expect(buildQuery({ id: [1, 2], vazio: null })).toBe('?id=1&id=2');
  });

  it('devolve string vazia quando não há query', () => {
    expect(buildQuery({})).toBe('');
  });
});

describe('FamachatClient', () => {
  it('faz login uma vez e reaproveita o token nas chamadas seguintes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockImplementation(async () => jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await client.request('GET', '/api/clientes');
    await client.request('GET', '/api/leads');

    const logins = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(logins).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('envia o token no header Authorization', async () => {
    const token = fakeJwt(3600);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: token }))
      .mockResolvedValue(jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await client.request('GET', '/api/clientes');

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it('refaz o login e repete a requisição uma vez ao receber 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Token revogado' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    const response = await client.request('GET', '/api/clientes');

    expect(response.status).toBe(200);
    const logins = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(logins).toHaveLength(2);
  });

  it('não entra em laço quando o segundo 401 persiste', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      String(url).endsWith('/api/auth/login')
        ? jsonResponse({ accessToken: fakeJwt(3600) })
        : jsonResponse({ message: 'negado' }, 401)
    );

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    const response = await client.request('GET', '/api/clientes');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('renova o token quando ele está perto de expirar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(30) }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await client.request('GET', '/api/clientes');
    await client.request('GET', '/api/leads');

    const logins = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(logins).toHaveLength(2);
  });

  it('propaga erro quando o login falha', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Credenciais inválidas' }, 401));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await expect(client.request('GET', '/api/clientes')).rejects.toThrow(/Login do usuário/);
  });

  it('devolve texto puro quando a resposta não é JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockResolvedValueOnce(new Response('pong', { status: 200 }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    const response = await client.request('GET', '/api/health');
    expect(response.body).toBe('pong');
  });

  it('envia corpo JSON em POST e omite em GET', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockImplementation(async () => jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await client.request('POST', '/api/clientes', { body: { fullName: 'Teste' } });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.body).toBe('{"fullName":"Teste"}');

    await client.request('GET', '/api/clientes', { body: { ignorado: true } });
    const [, getInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(getInit.body).toBeUndefined();
  });

  it('monta a URL com path params e query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: fakeJwt(3600) }))
      .mockImplementation(async () => jsonResponse({ ok: true }));

    const client = new FamachatClient(CONFIG, fetchMock as unknown as typeof fetch);
    await client.request('GET', '/api/clientes/:id/notes', {
      pathParams: { id: 7 },
      query: { limit: 5 },
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://backend.test/api/clientes/7/notes?limit=5');
  });
});
