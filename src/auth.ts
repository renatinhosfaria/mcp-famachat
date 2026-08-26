/**
 * Autenticação do Hermes contra este MCP server.
 *
 * O Hermes 0.14.0 só envia os headers estáticos declarados em `config.headers` do
 * `~/.hermes/config.yaml` (verificado em /opt/hermes/tools/mcp_tool.py) — então a
 * credencial é um Bearer token fixo, comparado em tempo constante.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type AuthOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: string; message: string };

/** Comparação sem vazar o tamanho nem o ponto de divergência do token. */
export function safeCompare(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // timingSafeEqual exige buffers do mesmo tamanho; compara contra si mesmo
    // para manter o custo constante antes de recusar.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * IP de origem confiável. Atrás do nginx o socket é sempre 127.0.0.1, então o
 * valor real vem de um header — mas nem todo header serve.
 *
 * `X-Forwarded-For` é montado com `$proxy_add_x_forwarded_for`, que **anexa** o
 * IP real ao que o cliente mandou. Ler o primeiro item leria justamente a parte
 * que o cliente controla: bastaria enviar `X-Forwarded-For: <ip-permitido>` para
 * furar a allowlist. O item confiável é o **último**, acrescentado pelo nginx.
 *
 * `X-Real-IP` é melhor ainda: o nginx o define com `proxy_set_header`, que
 * sobrescreve qualquer valor vindo de fora. É a primeira escolha.
 */
export function clientIpOf(req: Request): string {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const realIp = header('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = header('x-forwarded-for');
  const last = forwarded?.split(',').at(-1)?.trim();
  return last || req.socket.remoteAddress || 'desconhecido';
}

export function checkAuth(
  req: Request,
  expectedKey: string,
  ipAllowlist: readonly string[]
): AuthOutcome {
  const token = extractBearer(req.headers.authorization);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'MISSING_TOKEN',
      message: 'Envie Authorization: Bearer <token>',
    };
  }
  if (!safeCompare(token, expectedKey)) {
    return { ok: false, status: 403, code: 'INVALID_TOKEN', message: 'Token inválido' };
  }
  if (ipAllowlist.length > 0 && !ipAllowlist.includes(clientIpOf(req))) {
    return { ok: false, status: 403, code: 'IP_NOT_ALLOWED', message: 'Origem não autorizada' };
  }
  return { ok: true };
}

export function authMiddleware(expectedKey: string, ipAllowlist: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const outcome = checkAuth(req, expectedKey, ipAllowlist);
    if (outcome.ok) {
      next();
      return;
    }
    res.status(outcome.status).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: outcome.message, data: { code: outcome.code } },
      id: null,
    });
  };
}
