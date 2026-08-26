# Manual de Uso

O que o Hermes consegue fazer no FamaChat através deste servidor, como as ferramentas se
organizam e como operar o serviço no dia a dia.

Para instalar do zero, veja o [Guia de Instalação](INSTALACAO.md).

---

## As duas famílias de ferramentas

O agente enxerga 277 ferramentas, divididas em duas categorias que se comportam de
maneira bem diferente.

### `fc_*` — os endpoints do backend

Uma ferramenta por rota HTTP do FamaChat: 271 no total, em 41 módulos. Cada chamada passa
pelo Express do CRM, e portanto **dispara as regras de negócio** — rotação de leads por
SLA Cascata, eventos de Meta CAPI, webhooks de saída, validações, invalidação de cache.

É o caminho certo para criar e alterar dados. Um cliente criado por `fc_post_clientes`
entra no funil como qualquer outro; o mesmo registro inserido por SQL direto não.

### `db_*` — o banco, sem intermediários

Cinco ferramentas de acesso direto ao PostgreSQL de produção. Servem para consultas,
relatórios e correções em massa que nenhum endpoint cobre.

Escritas aqui **não disparam nada** do backend. E `db_query` aceita DDL — `CREATE`,
`ALTER`, `DROP`, `TRUNCATE` — por decisão explícita de dar autonomia total sobre o banco.

---

## Encontrando a ferramenta certa

Com 271 endpoints, adivinhar nomes não funciona. A ferramenta `fc_catalog` é o índice.

**Sem argumentos**, lista os módulos e quantas rotas cada um tem:

```
fc_catalog({})
→ 271 endpoints do FamaChat em 41 módulos
   38  whatsapp
   30  empreendimentos-page
   13  clientes
   12  agenda
   11  arquivos
   ...
```

**Por módulo**, lista as rotas com o nome exato da ferramenta:

```
fc_catalog({ modulo: "clientes" })
→ GET    /api/clientes            →  fc_get_clientes
  POST   /api/clientes            →  fc_post_clientes
  GET    /api/clientes/:id        →  fc_get_clientes_by_id
  PATCH  /api/clientes/:id        →  fc_patch_clientes_by_id
  DELETE /api/clientes/:id        →  fc_del_clientes_by_id
  ...
```

**Por busca livre**, entendendo português e acentos:

```
fc_catalog({ busca: "agendamento" })   → encontra /api/appointments
fc_catalog({ busca: "imóveis" })       → encontra casas, apartamentos, terrenos
fc_catalog({ busca: "venda" })         → encontra /api/sales
```

Boa parte das rotas está em inglês enquanto a conversa acontece em português, então a
busca traduz: `agendamento`→`appointment`, `venda`→`sale`, `usuário`→`user`,
`painel`→`dashboard`, `mensagem`→`whatsapp`, entre outros. Acentos e plural simples
também são resolvidos.

### Como os nomes são formados

O padrão é previsível, o que ajuda quando você já viu um parecido:

| Rota | Ferramenta |
|---|---|
| `GET /api/clientes` | `fc_get_clientes` |
| `POST /api/clientes` | `fc_post_clientes` |
| `GET /api/clientes/:id` | `fc_get_clientes_by_id` |
| `PATCH /api/clientes/:id` | `fc_patch_clientes_by_id` |
| `DELETE /api/clientes/:id` | `fc_del_clientes_by_id` |
| `GET /api/clientes/:id/notes` | `fc_get_clientes_by_id_notes` |
| `DELETE /api/clientes/notes/:noteId` | `fc_del_clientes_notes_by_noteid` |

Prefixo `fc_`, o método (`get`/`post`/`put`/`patch`/`del`), depois o caminho com `/`
virando `_` e cada `:parâmetro` virando `by_parâmetro`.

---

## Chamando um endpoint

Toda ferramenta `fc_*` aceita a mesma forma de argumentos:

- **um campo por parâmetro de rota** — `id`, `noteId`, `userId`…
- **`query`** — objeto com os parâmetros de query string
- **`body`** — objeto com o corpo JSON (só em POST, PUT, PATCH e DELETE)

```jsonc
// GET /api/clientes?limit=20&status=Em Atendimento
fc_get_clientes({ query: { limit: 20, status: "Em Atendimento" } })

// GET /api/clientes/12790
fc_get_clientes_by_id({ id: 12790 })

// POST /api/clientes
fc_post_clientes({
  body: { fullName: "Maria Silva", phone: "(34) 99999-1234", source: "WhatsApp" }
})

// PATCH /api/clientes/12790
fc_patch_clientes_by_id({ id: 12790, body: { status: "Em Atendimento" } })

// GET /api/clientes/12790/notes?limit=5
fc_get_clientes_by_id_notes({ id: 12790, query: { limit: 5 } })
```

A resposta traz o status HTTP e o corpo cru, sem reinterpretação:

```json
{
  "status": 200,
  "statusText": "OK",
  "truncated": false,
  "body": { "data": [ ... ] }
}
```

A API do FamaChat não tem um envelope único — algumas rotas devolvem o objeto direto,
outras `{ success, message }`, outras um array. O servidor repassa o que veio. Status
igual ou acima de 400 marca a resposta como erro.

Respostas acima de 1 MB vêm cortadas, com `truncated: true`. Quando isso acontecer,
estreite o resultado com `query` (paginação, filtros) em vez de pedir tudo de novo.

---

## Consultando o banco

```jsonc
// Sempre prefira parâmetros a interpolar valores no texto
db_query({
  sql: "SELECT id, full_name, status FROM clientes WHERE broker_id = $1 LIMIT 50",
  params: [24]
})

// Teto de linhas: padrão 1000, ajustável por chamada
db_query({ sql: "SELECT * FROM sistema_leads", max_rows: 200 })
```

Retorna comando, linhas afetadas, duração e os dados:

```
comando: SELECT | linhas afetadas/retornadas: 3 | duração: 588ms

[ { "id": 12790, "full_name": "Maria Silva", "status": "Em Atendimento" } ]
```

### Antes de escrever SQL

O schema não é adivinhável — as tabelas usam `snake_case` no banco, enquanto a API
devolve `camelCase`:

```jsonc
db_list_tables({})                          // o que existe e o tamanho de cada tabela
db_describe_table({ table: "clientes" })    // colunas, tipos, constraints, índices, FKs
db_list_enums({})                           // valores aceitos nos campos enum
db_explain({ sql: "SELECT ..." })           // plano de execução, antes de rodar algo pesado
```

### As tabelas principais

| Tabela | Guarda |
|---|---|
| `clientes` | O funil comercial — o coração do CRM |
| `clientes_id_anotacoes` | Histórico e notas de cada cliente |
| `clientes_agendamentos` | Compromissos da agenda |
| `clientes_visitas` | Visitas a imóveis |
| `sistema_users` | Corretores, gestores e o próprio `hermes-agent` |
| `sistema_leads` | Leads captados |
| `sistema_leads_sla_cascata` | Rotação de leads pelo SLA Cascata |
| `imoveis_empreendimentos`, `imoveis_apartamentos` | Catálogo imobiliário |
| `sistema_auth_audit_log` | Trilha de autenticação do backend |

`db_describe_table` dá o detalhe de qualquer uma.

---

## Endpoint ou banco: como escolher

| Situação | Use |
|---|---|
| Criar cliente, lead, agendamento, venda | **`fc_*`** — as regras de negócio precisam rodar |
| Mudar status de um cliente no funil | **`fc_*`** — dispara Meta CAPI e webhooks |
| Relatório, contagem, cruzamento de tabelas | **`db_query`** — muito mais direto |
| Buscar algo que nenhum endpoint filtra | **`db_query`** |
| Corrigir dado em massa (centenas de linhas) | **`db_query`**, ciente de que nada é disparado |
| Entender a estrutura do banco | **`db_describe_table`** |

A regra curta: **ler pelo banco, escrever pelo endpoint**. Escrever direto no banco é
possível e às vezes é o certo — mas o registro não vai gerar evento de CAPI, não vai
disparar webhook e não vai entrar na rotação de SLA.

---

## O que exige confirmação

O agente tem acesso irrestrito. Três categorias merecem uma pergunta antes:

**DDL.** `CREATE`, `ALTER`, `DROP`, `TRUNCATE` mudam a estrutura de que o FamaChat
depende para funcionar. `DROP TABLE clientes` não apaga um cliente: apaga
todos eles e a própria tabela. Comandos assim ficam registrados com aviso no log da aplicação.

**Escrita em massa sem `WHERE`.** Um `UPDATE clientes SET status = ...` sem cláusula
atinge a base inteira.

**Exclusões.** As ferramentas `fc_del_*` e `DELETE` em SQL removem de verdade.

> **Sobre restaurar:** o banco de produção não tem point-in-time recovery
> (`archive_mode = off`) e o backup automático que roda neste servidor cobre outro banco.
> Na prática, hoje um comando destrutivo não tem de onde ser desfeito. Vale confirmar o
> estado do backup antes de operações de risco.

---

## Auditoria

Toda chamada de ferramenta vira uma linha em `logs/audit.jsonl`:

```json
{"ts":"2026-08-26T16:33:17.694Z","tool":"fc_post_clientes","target":"POST /api/clientes",
 "args":{"body":{"fullName":"..."}},"status":"ok","httpStatus":201,"durationMs":1103}
```

```bash
tail -f logs/audit.jsonl                                    # acompanhar ao vivo
grep '"tool":"db_query"' logs/audit.jsonl | tail -20        # só as consultas SQL
grep '"status":"error"' logs/audit.jsonl | tail -20         # só as falhas
```

O arquivo fica em disco, fora do alcance de qualquer ferramenta exposta — como o agente
pode executar DDL, a trilha não podia morar no banco que ele administra. Retenção de 90
dias.

Do lado do Postgres, as sessões do agente aparecem no `pg_stat_activity` com
`application_name = mcp-hermes`, o que as separa das do backend.

---

## Operação

### Comandos do dia a dia

```bash
pm2 status mcp-famachat            # está no ar?
pm2 logs mcp-famachat --lines 50   # log da aplicação
pm2 restart mcp-famachat           # reiniciar
curl -s https://mcp.famachat.com.br/health
```

O `/health` responde sem token e sem filtro de IP, e mostra o essencial:

```json
{"status":"ok","server":{"name":"famachat","version":"1.0.0"},
 "tools":277,"backendCommit":"e1acfed","uptimeSeconds":1368}
```

O `backendCommit` diz de qual versão do FamaChat o catálogo foi gerado. Se estiver atrás
do que roda em produção, o agente está vendo rotas desatualizadas.

### Quando as rotas do FamaChat mudam

Toda vez que um endpoint for criado, removido ou renomeado no backend:

```bash
cd /var/www/mcp-famachat
pnpm gen:routes
pnpm build
pm2 restart mcp-famachat
```

Sem isso, o agente continua com o catálogo antigo — ferramentas que respondem 404 e rotas
novas que ele nem enxerga. O Hermes relê `tools/list` ao reconectar.

### Rotacionar a senha do Hermes

```bash
NOVA=$(openssl rand -hex 32)
sed -i "s|^MCP_API_KEY=.*|MCP_API_KEY=$NOVA|" .env
pm2 restart mcp-famachat --update-env
bash hermes-config-snippet.sh    # gera o bloco novo para o config.yaml do Hermes
```

O Hermes só volta a conectar depois de atualizar o `config.yaml` dele e reiniciar o
daemon — planeje os dois passos juntos.

### Cortar o acesso do agente

Três níveis, do mais brando ao mais severo:

```sql
-- 1. Tira o acesso ao backend, mantém o banco (as fc_* passam a falhar)
UPDATE sistema_users SET is_active = false WHERE username = 'hermes-agent';
```

```bash
# 2. Fecha o servidor para todo mundo, sem derrubar nada
sed -i 's|^MCP_IP_ALLOWLIST=.*|MCP_IP_ALLOWLIST=127.0.0.1|' .env
pm2 restart mcp-famachat --update-env

# 3. Desliga o MCP
pm2 stop mcp-famachat
```

---

## Limites que valem conhecer

| Limite | Padrão | Variável |
|---|---|---|
| Linhas por consulta SQL | 1000 | `DB_MAX_ROWS` |
| Duração de uma query | 30s | `DB_STATEMENT_TIMEOUT_MS` |
| Duração de uma chamada ao backend | 60s | `FAMACHAT_REQUEST_TIMEOUT_MS` |
| Tamanho da resposta do backend | 1 MB | `FAMACHAT_MAX_RESPONSE_BYTES` |
| Conexões simultâneas ao banco | 5 | `DB_POOL_MAX` |
| Corpo da requisição | 25 MB | nginx e Express |

Estourar um limite não quebra nada: a consulta volta com `truncated: true`, ou o erro
explica o que aconteceu.

Duas coisas que o servidor **não** faz: upload de arquivo binário pelas ferramentas (os
endpoints de mídia esperam `multipart/form-data`, e as ferramentas mandam JSON) e
streaming de resultado — toda resposta chega inteira.

---

## Perguntas frequentes

**O agente pode apagar o CRM inteiro?**
Tecnicamente sim: `db_query` aceita DDL, por decisão de projeto. Por isso os avisos, a
auditoria em disco e a recomendação de confirmar comandos destrutivos.

**As ações do agente aparecem no FamaChat como de quem?**
Do usuário `hermes-agent` (id 40, papel Gestor). Ele aparece nos logs, no
`sistema_auth_audit_log` e como `brokerId` nos registros que criar.

**Por que uma ferramenta responde 404?**
A rota saiu ou mudou de nome no backend e o manifesto está velho. Rode `pnpm gen:routes`.

**Por que uma ferramenta responde 403?**
O papel `Gestor` cobre quase tudo, mas algumas rotas checam departamento além do papel.
O corpo da resposta diz qual permissão faltou.

**Dá para o Hermes ver só parte das ferramentas?**
Sim, e sem tocar no servidor: use `tools.include` ou `tools.exclude` no `config.yaml` do
Hermes. Útil se o modelo começar a errar a escolha entre as 277.

**O servidor guarda estado entre chamadas?**
Não. Ele roda em modo stateless: cada requisição é independente, e um restart do PM2 é
transparente para o Hermes. A única coisa mantida em memória é o token JWT do usuário de
serviço, que se renova sozinho.
