#!/usr/bin/env tsx
/**
 * Cria (ou atualiza a senha de) o usuário de serviço que o MCP usa para falar com
 * o backend do FamaChat.
 *
 * Por que um usuário próprio, e não as credenciais de alguém: as ações do agente
 * ficam distinguíveis das de uma pessoa nos logs e no funil, e revogar o acesso
 * é desativar um registro — sem trocar a senha de ninguém.
 *
 * A senha é gerada aqui e impressa uma única vez. Ela não é gravada em lugar
 * nenhum além do que você colar no `.env`.
 *
 * Uso:
 *   pnpm provision:user                  # cria, ou informa que já existe
 *   pnpm provision:user --rotate         # gera uma senha nova para o usuário existente
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';

const BCRYPT_ROUNDS = 10;
const USERNAME = 'hermes-agent';
const FULL_NAME = 'Hermes Agent (MCP)';
const ROLE = 'Gestor';
const DEPARTMENT = 'Gestão';

type ExistingUser = { id: number; email: string | null; is_active: boolean | null };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} não está definida no .env`);
  return value;
}

function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

async function main(): Promise<void> {
  const rotate = process.argv.includes('--rotate');
  const databaseUrl = requireEnv('DATABASE_URL');
  const email = requireEnv('FAMACHAT_SERVICE_EMAIL');

  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: 'mcp-provision' });

  try {
    const existing = await pool.query<ExistingUser>(
      'SELECT id, email, is_active FROM sistema_users WHERE email = $1 OR username = $2 LIMIT 1',
      [email, USERNAME]
    );
    const user = existing.rows[0];

    if (user && !rotate) {
      console.log(
        [
          `O usuário de serviço já existe (id ${user.id}, email ${user.email}, ativo: ${user.is_active}).`,
          'Nada foi alterado. Para gerar uma senha nova, rode com --rotate.',
        ].join('\n')
      );
      return;
    }

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (user) {
      await pool.query(
        `UPDATE sistema_users
            SET password_hash = $1, is_active = true, failed_login_attempts = 0,
                locked_until = NULL, token_version = COALESCE(token_version, 0) + 1
          WHERE id = $2`,
        [passwordHash, user.id]
      );
      // O bump de token_version invalida os JWTs antigos — o MCP refaz login sozinho.
      console.log(`Senha rotacionada para o usuário ${user.id}. Tokens anteriores foram revogados.`);
    } else {
      const created = await pool.query<{ id: number }>(
        `INSERT INTO sistema_users
           (username, password_hash, full_name, email, role, department, is_active, token_version)
         VALUES ($1, $2, $3, $4, $5, $6, true, 0)
         RETURNING id`,
        [USERNAME, passwordHash, FULL_NAME, email, ROLE, DEPARTMENT]
      );
      console.log(`Usuário de serviço criado com id ${created.rows[0]?.id}.`);
    }

    console.log(
      [
        '',
        'Copie para o .env do MCP — esta senha não será mostrada de novo:',
        '',
        `FAMACHAT_SERVICE_EMAIL=${email}`,
        `FAMACHAT_SERVICE_PASSWORD=${password}`,
        '',
        `Papel: ${ROLE} / ${DEPARTMENT}. Para revogar o acesso do agente:`,
        `  UPDATE sistema_users SET is_active = false WHERE username = '${USERNAME}';`,
      ].join('\n')
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Falha no provisionamento: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
