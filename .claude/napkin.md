# Napkin — mcp-famachat

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-08-26 | self | Gerador de rotas varria `server/**` inteiro e captou `whatsappApi.post('...')` — um cliente HTTP da Evolution API, não um router | Só aceitar receivers que sejam `Router()`/`express.Router()` locais ou parâmetros tipados `Express`/`Router`/`Application`/`IRouter` |
| 2026-08-26 | self | Varredura cega incluiu `server/routes/appointments.ts` e `server/routes/jwks.ts` — arquivos órfãos, não importados por ninguém. Virariam ~23 ferramentas que sempre respondem 404 | Percorrer o grafo de registro a partir de `server/routes.ts` (`app.use` + chamadas `registerXRoutes`), não listar diretórios |
| 2026-08-26 | self | Parar no `index.ts` do módulo perdeu as 12 rotas de `modules/agenda` — o index só faz `export { agendaRouter } from './routes/agenda.routes'` | Seguir re-exports (`export { x } from` e `export * from`) até o arquivo que declara o router |
| 2026-08-26 | self | `registerUploadRoutes(app: express.Express)` não foi reconhecido — o tipo é `QualifiedName`, não `Identifier` | Tratar as duas formas ao ler o tipo do parâmetro na AST |
| 2026-08-26 | self | `registerOgImageRoutes` monta `app.use('/api/og-image', router)` dentro do próprio arquivo; a rota saiu sem prefixo | Coletar mounts locais por receiver, não só os de `routes.ts` |
| 2026-08-26 | self | Nome de tool saiu como `fc_post_rate_limit_reset_by_userid?` — o `?` do parâmetro opcional do Express vazou | Sanitizar todo segmento; `*` vira `wildcard` |
| 2026-08-26 | self | Teste com `mockResolvedValue(jsonResponse(...))` reusava o mesmo `Response`, que só pode ser lido uma vez | Usar `mockImplementation(async () => jsonResponse(...))` para criar um objeto novo por chamada |
| 2026-08-26 | self | `fc_catalog` com busca "agendamento" não achava nada — as rotas são `/api/appointments` | Tabela de sinônimos PT→EN + normalização de acentos e plural. O Hermes opera em português |

## User Preferences
- Decisões tomadas por Renato em 26/08/2026: uma tool MCP por endpoint (não uma genérica); acesso ao Postgres **sem trava**, dados e estrutura, DDL incluído; usuário de serviço dedicado para o backend; repositório GitHub público mesmo após alerta sobre exposição da superfície.

## Patterns That Work
- Manifesto de rotas commitado (`routes/backend-routes.json`) gerado por AST: revisável em diff, e o backend do FamaChat não precisa ser alterado.
- Handshake MCP testado in-process com `InMemoryTransport` + `Client` do SDK — pega erro de schema e de registro sem subir servidor HTTP.
- Modo **stateless** do `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`): restart do PM2 fica transparente, sem 404 de sessão perdida.
- Capturar a senha gerada num pipeline shell direto para o `.env`, sem passar pelo transcript.

## Domain Notes
- **Duas versões de Hermes em jogo — não confundir.** O container local `famachat-saas-hermes-daemon-1` roda **0.14.0**; o VPS que consome este MCP roda **0.20.5**. Verificar comportamento no container local e concluir sobre o consumidor foi um erro (26/08): a 0.20.5 tem recursos que a 0.14.0 não tem. Ao investigar, usar o código da `main` do repo `NousResearch/hermes-agent`, não o container.
- **Hermes (ambas as versões)**: servidores por `url` usam Streamable HTTP; envia os headers estáticos de `config.headers` + `mcp-protocol-version`; abre a conexão uma vez no boot; suporta `tools.include`/`exclude`, `timeout`, `connect_timeout`.
- **Hermes 0.20.5, o que mudou** (verificado em `tools/mcp_tool.py` e `tools/mcp_oauth.py` da main):
  - `auth: oauth` — OAuth 2.1 com PKCE, via `OAuthClientProvider` do SDK Python. Grants: só `authorization_code` + `refresh_token`; **sem `client_credentials`**, então a primeira autorização passa por navegador. Usar OAuth exigiria virar Authorization Server 2.1 completo (RFC 9728 + 8414 + PKCE + 7591/CIMD). Bearer estático continua suportado e é o que usamos.
  - **Preflight de content-type** antes de conectar: HEAD, e GET se vier 405. Só rejeita resposta **2xx** com content-type fora de `application/json`/`text/event-stream`. Nosso `/mcp` responde 405 em HEAD/GET → passa. `skip_preflight: true` existe para quem falha nisso.
  - `keepalive_interval` (padrão 180s) manda `ping` JSON-RPC — nosso servidor responde mesmo stateless.
  - `identity_header`, `ssl_verify`, `client_cert`, `lifecycle` (recycle de stdio) também são novos.
- Backend do FamaChat: guarda de auth global roda **antes** do roteamento — rota inexistente também devolve 401. Não dá para sondar existência de rota sem token válido.
- Login do backend usa **email** (não username); access token 1h, refresh 7d; `token_version` invalida tokens antigos.
- Usuário de serviço: `hermes-agent`, id 40, papel `Gestor`/`Gestão`. Revogar com `UPDATE sistema_users SET is_active = false WHERE username = 'hermes-agent'`.
- Banco de produção: `neondb` em `144.126.134.23:5432`, ~40 MB, 8.477 clientes.

## ⚠ Backup do banco de produção (verificado em 2026-08-26)
O banco de produção **não tem backup automático funcionando**:
- `archive_mode = off` → sem point-in-time recovery.
- `famachat-backup.timer` (systemd, 02:22, roda com sucesso) faz `docker exec famachat-saas-postgres-1 pg_dump -d famachat_saas` — é o banco do **famachat-saas**, outro banco.
- O cron das 03:00 chama `/var/www/famachat/backup_complete.sh`, que **não existe** no working tree; o destino `/var/www/backups` também não existe.

Isso importa porque o agente tem DDL liberado: um `DROP TABLE` não teria de onde ser restaurado. Confirmar com Renato antes de assumir que existe backup em outro lugar.
