# mcp-famachat

Servidor MCP que dá ao [Hermes Agent](https://hermes-agent.nousresearch.com/docs) acesso
ao FamaChat: **todos os endpoints do backend** e **o PostgreSQL de produção**.

Publicado em `https://mcp.famachat.com.br/mcp`, autenticado por Bearer token.

```
VPS Hermes  ──HTTPS + Bearer──▶  nginx :443 (mcp.famachat.com.br)
                                      │
                                      ▼
                           mcp-famachat (PM2, :5100)
                           Streamable HTTP em POST /mcp
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
         ferramentas fc_*  ──JWT──▶        ferramentas db_*  ──pg──▶
         famachat-backend :5000             PostgreSQL de produção
         (regras de negócio aplicadas)      (SQL direto, DDL liberado)
```

## Ferramentas

| Família | Quantidade | O que faz |
|---|---|---|
| `fc_*` | uma por endpoint do backend | Chama o endpoint HTTP correspondente. Passa pelas regras de negócio do FamaChat: rotação de leads por SLA Cascata, eventos de Meta CAPI, webhooks de saída |
| `fc_catalog` | 1 | Índice das ferramentas `fc_*`. Busca entende português: `agendamento` encontra `/api/appointments` |
| `db_query` | 1 | SQL arbitrário no banco de produção, **DDL incluído** |
| `db_list_tables`, `db_describe_table`, `db_list_enums`, `db_explain` | 4 | Inspeção do schema e de planos de execução |

O total é impresso no boot e exposto em `GET /health`.

## Duas credenciais, dois propósitos

**Hermes → MCP**: Bearer token estático (`MCP_API_KEY`), comparado em tempo constante.
O Hermes 0.14.0 só envia os headers estáticos declarados no `config.yaml`, então esta é
a única forma de credencial que chega até aqui.

**MCP → backend**: o usuário de serviço `hermes-agent` (papel `Gestor`). O servidor faz
login em `/api/auth/login`, guarda o access token de 1h em memória e renova sozinho. As
ações do agente ficam distinguíveis das de uma pessoa nos logs do FamaChat.

Para revogar o acesso do agente ao backend sem mexer em mais nada:

```sql
UPDATE sistema_users SET is_active = false WHERE username = 'hermes-agent';
```

## Auditoria

Toda chamada de ferramenta vira uma linha em `logs/audit.jsonl` — ferramenta, argumentos,
SQL, status, linhas afetadas e duração. O arquivo fica no disco, fora do alcance de
qualquer ferramenta exposta: como o agente pode executar DDL, a trilha não pode morar no
banco que ele administra. Retenção de 90 dias via `/etc/logrotate.d/mcp-famachat`.

No lado do Postgres, as sessões do agente aparecem no `pg_stat_activity` com
`application_name = mcp-hermes`.

## Comandos

```bash
pnpm install
pnpm gen:routes        # regenera o manifesto a partir de /var/www/famachat
pnpm build             # tsc → dist/
pnpm start             # node --env-file=.env dist/index.js
pnpm dev               # tsx, sem build
pnpm check             # typecheck de src, scripts e tests
pnpm test              # Vitest
pnpm provision:user    # cria o usuário de serviço (--rotate troca a senha)
```

## O manifesto de rotas

`routes/backend-routes.json` lista as rotas do backend e é a fonte das ferramentas `fc_*`.
É gerado por `scripts/generate-routes.ts`, que percorre a AST do TypeScript a partir de
`server/routes.ts` seguindo o grafo de registro — `app.use(prefixo, router)`, funções
`registerXRoutes(app)` e as cascatas entre elas.

Varrer `server/**` inteiro daria errado: o backend tem arquivos de rota órfãos
(`server/routes/appointments.ts` e `server/routes/jwks.ts` não são importados por
ninguém), e gerar ferramentas para eles daria ao agente dezenas de ações que sempre
respondem 404.

**Sempre que rotas mudarem no FamaChat**, rode `pnpm gen:routes && pnpm build` e reinicie
o processo. Sem isso, o agente continua vendo o catálogo antigo.

## Deploy

```bash
pnpm install && pnpm build && pnpm gen:routes
pm2 restart mcp-famachat --update-env
```

nginx: `/etc/nginx/sites-available/mcp.famachat.com.br`. O `proxy_buffering off` não é
opcional — o Streamable HTTP pode responder em SSE, e com buffering o cliente só receberia
a resposta no final.

## Configuração no VPS do Hermes

Em `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  famachat:
    url: "https://mcp.famachat.com.br/mcp"
    headers:
      Authorization: "Bearer <MCP_API_KEY>"
    timeout: 180
    connect_timeout: 30
```

Se o modelo começar a errar a escolha entre as ferramentas, recorte o catálogo com
`tools.include: [...]` no lado do Hermes — sem mexer no servidor.

## Variáveis de ambiente

Veja `.env.example`. As que importam:

| Variável | Para quê |
|---|---|
| `MCP_API_KEY` | A senha que o Hermes envia. Gere com `openssl rand -hex 32` |
| `MCP_IP_ALLOWLIST` | IPs autorizados, separados por vírgula. Vazio desliga a checagem |
| `MCP_STATEFUL` | `0` (padrão) = sem sessão; `1` = sessão com `Mcp-Session-Id` |
| `FAMACHAT_SERVICE_EMAIL` / `_PASSWORD` | Credenciais do usuário de serviço |
| `DATABASE_URL` | Conexão com o PostgreSQL de produção |
| `DB_MAX_ROWS` | Teto de linhas por consulta (padrão 1000) |
