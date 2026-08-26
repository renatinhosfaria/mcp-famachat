/**
 * Cliente HTTP do backend do FamaChat, autenticado por um usuário de serviço.
 *
 * O backend protege todo `/api/*` com JWT Bearer (server/middleware/auth.ts). Este
 * cliente faz login com as credenciais do `hermes-agent`, guarda o access token em
 * memória e o renova sozinho — o token vale 1h e o refresh 7 dias
 * (server/routes/auth.ts). As ações do agente ficam assim rastreáveis no
 * `sistema_auth_audit_log` sob uma identidade própria.
 */

import type { Config } from '../config.js';

/** Renova antes do vencimento para não perder uma chamada por corrida de relógio. */
const RENEW_MARGIN_MS = 60_000;

export type ApiResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  truncated: boolean;
};

export type RequestOptions = {
  pathParams?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
};

type LoginPayload = {
  success?: boolean;
  message?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: { id: number; username: string; role: string };
};

export class FamachatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FamachatApiError';
  }
}

/** Nome usado para o segmento `*` das rotas wildcard do Express. */
export const WILDCARD_PARAM = 'wildcard';

/**
 * Substitui os parâmetros no path, codificando cada valor.
 *
 * Cobre as três formas que o Express aceita e que aparecem no backend:
 * `:nome` (obrigatório), `:nome?` (opcional — o segmento inteiro some quando o
 * valor não vem) e `*` (wildcard, cujo valor pode conter barras e por isso não
 * é escapado por completo).
 */
export function buildPath(route: string, pathParams: Record<string, string | number> = {}): string {
  const withOptional = route.replace(/\/:([A-Za-z0-9_]+)\?/g, (_match, name: string) => {
    const value = pathParams[name];
    const missing = value === undefined || value === null || value === '';
    return missing ? '' : `/${encodeURIComponent(String(value))}`;
  });

  const withRequired = withOptional.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || value === '') {
      throw new FamachatApiError(`Parâmetro de rota ausente: ${name}`);
    }
    return encodeURIComponent(String(value));
  });

  return withRequired.replace(/\*/g, () => {
    const value = pathParams[WILDCARD_PARAM];
    if (value === undefined || value === null || value === '') {
      throw new FamachatApiError(`Parâmetro de rota ausente: ${WILDCARD_PARAM}`);
    }
    // O wildcard costuma ser um caminho (`pasta/arquivo.pdf`): preserva as barras.
    return String(value)
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  });
}

export function buildQuery(query: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (typeof value === 'object') {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class FamachatClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly config: Pick<
      Config,
      | 'FAMACHAT_API_URL'
      | 'FAMACHAT_SERVICE_EMAIL'
      | 'FAMACHAT_SERVICE_PASSWORD'
      | 'FAMACHAT_REQUEST_TIMEOUT_MS'
      | 'FAMACHAT_MAX_RESPONSE_BYTES'
    >,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Expõe a identidade em uso, para o health check e os logs de partida. */
  get serviceEmail(): string {
    return this.config.FAMACHAT_SERVICE_EMAIL;
  }

  private async login(): Promise<string> {
    const response = await this.fetchWithTimeout(`${this.config.FAMACHAT_API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.config.FAMACHAT_SERVICE_EMAIL,
        password: this.config.FAMACHAT_SERVICE_PASSWORD,
      }),
    });

    const payload = (await response.json().catch(() => null)) as LoginPayload | null;

    if (!response.ok || !payload?.accessToken) {
      throw new FamachatApiError(
        `Login do usuário de serviço falhou (${response.status}): ${payload?.message ?? response.statusText}`,
        response.status
      );
    }

    this.accessToken = payload.accessToken;
    this.expiresAt = expiryOf(payload.accessToken);
    return payload.accessToken;
  }

  /** Um login por vez: chamadas concorrentes compartilham a mesma promessa. */
  private async getToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS) {
      return this.accessToken;
    }
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.FAMACHAT_REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new FamachatApiError(
          `Tempo esgotado após ${this.config.FAMACHAT_REQUEST_TIMEOUT_MS}ms em ${url}`
        );
      }
      throw new FamachatApiError(
        `Falha de rede ao chamar o backend: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method: string, route: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const path = buildPath(route, options.pathParams);
    const url = `${this.config.FAMACHAT_API_URL}${path}${buildQuery(options.query)}`;
    const hasBody = options.body !== undefined && method !== 'GET' && method !== 'HEAD';

    const send = async (token: string): Promise<Response> =>
      this.fetchWithTimeout(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });

    let response = await send(await this.getToken());

    // Token revogado ou expirado antes do previsto: um único re-login e replay.
    if (response.status === 401) {
      response = await send(await this.getToken(true));
    }

    return this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<ApiResponse> {
    const raw = await response.text();
    const limit = this.config.FAMACHAT_MAX_RESPONSE_BYTES;
    const truncated = raw.length > limit;
    const text = truncated ? raw.slice(0, limit) : raw;

    let body: unknown = text;
    if (!truncated && text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A API não tem envelope único e algumas rotas devolvem texto puro.
        body = text;
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (key === 'content-type' || key === 'content-length') headers[key] = value;
    }

    return { status: response.status, statusText: response.statusText, headers, body, truncated };
  }
}

/** Lê o `exp` do JWT sem verificar assinatura — serve só para agendar a renovação. */
function expiryOf(token: string): number {
  try {
    const payload = token.split('.')[1];
    if (!payload) return Date.now() + 55 * 60_000;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return decoded.exp ? decoded.exp * 1000 : Date.now() + 55 * 60_000;
  } catch {
    return Date.now() + 55 * 60_000;
  }
}
