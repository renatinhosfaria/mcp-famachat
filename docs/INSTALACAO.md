# Guia de Instalação

**Não há nada a instalar.** O servidor já está no ar em `https://mcp.famachat.com.br`.
Conectar leva poucos minutos: você informa ao seu cliente MCP o endereço e a senha, e ele
passa a enxergar as 277 ferramentas do FamaChat.

Depois de conectar, veja o [Manual de Uso](MANUAL.md) para saber o que fazer com elas.

---

## Passo 0 — Pegar a senha

A senha vive apenas no arquivo `.env` do servidor. Quem tem acesso a ele roda:

```bash
# Imprime o bloco de configuração do Hermes, já com a senha preenchida
bash /var/www/mcp-famachat/hermes-config-snippet.sh
```

Para os outros clientes, só o token:

```bash
grep -oP '(?<=^MCP_API_KEY=).*' /var/www/mcp-famachat/.env
```

Guarde em variável de ambiente ou gerenciador de segredos. Não coloque a senha em arquivo
versionado, nem cole em chat — quem tem esse token opera o CRM inteiro.

---

# Parte 1 — Hermes Agent

## 1. Editar o `config.yaml`

No VPS onde o Hermes roda, abra `~/.hermes/config.yaml` e acrescente:

```yaml
mcp_servers:
  famachat:
    url: "https://mcp.famachat.com.br/mcp"
    headers:
      Authorization: "Bearer <MCP_API_KEY>"
    timeout: 180
    connect_timeout: 30
```

Substitua `<MCP_API_KEY>` pela senha do passo 0. Se o arquivo já tiver uma chave
`mcp_servers`, acrescente `famachat` sob ela em vez de repetir a chave.

Os dois timeouts não são enfeite: uma consulta pesada ao banco ou um endpoint lento do CRM
podem passar de um minuto, e o padrão do Hermes é curto demais para isso.

## 2. Reiniciar o daemon

O Hermes abre a conexão MCP uma única vez, no boot. Ele não recarrega o `config.yaml`
sozinho — reinicie o daemon para a mudança valer.

## 3. Confirmar que conectou

Duas formas. Pelo log do Hermes, procurando o servidor `famachat` no registro de MCP. Ou,
mais simples, peça ao agente:

> Chame a ferramenta `fc_catalog` e me diga quantos endpoints do FamaChat você tem.

Se ele responder com a lista de módulos — `whatsapp`, `clientes`, `agenda`,
`empreendimentos-page` e companhia —, está conectado.

## 4. Primeiros comandos

Peça ao agente, em português mesmo:

> Quantos clientes existem no FamaChat?

> Liste os 5 clientes mais recentes com nome, telefone e status.

> Quais ferramentas existem para agendamento?

O primeiro usa `db_query`, o segundo também, o terceiro passa por `fc_catalog`. Se os três
funcionarem, o servidor está entregue de ponta a ponta.

## Sobre a allowlist

Só o IP do VPS do Hermes está liberado, além dos endereços de diagnóstico do próprio
servidor. De qualquer outro lugar a resposta é `403 IP_NOT_ALLOWED`, mesmo com a senha
certa.

Se o Hermes mudar de IP — ou se você quiser conectar de outra máquina —, o novo endereço
precisa entrar em `MCP_IP_ALLOWLIST`, no `.env` do servidor.

---

# Parte 2 — Outros clientes MCP

O servidor é um MCP padrão: qualquer cliente compatível conecta. O que muda é só onde
cada um guarda a configuração.

## Claude Code

Comando pronto:

```bash
claude mcp add --transport http famachat https://mcp.famachat.com.br/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

Ou, se preferir editar o JSON — em `.mcp.json` na raiz do projeto, ou `~/.claude.json`:

```json
{
  "mcpServers": {
    "famachat": {
      "type": "http",
      "url": "https://mcp.famachat.com.br/mcp",
      "headers": {
        "Authorization": "Bearer ${FAMACHAT_MCP_TOKEN}"
      }
    }
  }
}
```

O Claude Code expande `${FAMACHAT_MCP_TOKEN}` a partir do ambiente, então esse arquivo
pode ir para o controle de versão sem levar a senha junto. Exporte a variável antes de
abrir o Claude Code.

O `"type": "http"` é obrigatório. Uma entrada com `url` e sem `type` é lida como servidor
stdio e falha.

Três escopos, conforme onde você quer o servidor disponível:

| Escopo | Onde vale | Arquivo |
|---|---|---|
| `local` (padrão) | Só o projeto atual | `~/.claude.json` |
| `project` | Projeto atual, versionado com o time | `.mcp.json` na raiz |
| `user` | Todos os seus projetos | `~/.claude.json` |

Passe `--scope user` no comando acima para deixar disponível em qualquer projeto.

## Codex

Em `.mcp.json`, no mesmo formato que o plugin `mcp-fama` já usa para os outros servidores
da Fama:

```json
{
  "mcpServers": {
    "famachat": {
      "type": "http",
      "url": "https://mcp.famachat.com.br/mcp",
      "bearer_token_env_var": "FAMACHAT_MCP_TOKEN"
    }
  }
}
```

O Codex lê o token da variável de ambiente nomeada em `bearer_token_env_var` — o valor
nunca aparece no arquivo. Exporte `FAMACHAT_MCP_TOKEN` no ambiente onde o Codex roda.

## Qualquer outro cliente

Se o seu cliente não está aqui, é isto que ele precisa saber:

| Campo | Valor |
|---|---|
| Endpoint | `https://mcp.famachat.com.br/mcp` |
| Método | `POST` |
| Transporte | Streamable HTTP (o padrão do MCP para servidores remotos) |
| Autenticação | Header `Authorization: Bearer <MCP_API_KEY>` |
| Sessão | Não usa — o servidor é stateless |

Para testar sem cliente nenhum:

```bash
curl -s -X POST https://mcp.famachat.com.br/mcp \
  -H "Authorization: Bearer <MCP_API_KEY>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Quando não conecta

Comece sempre pelo `/health`, que é público — responde sem senha e sem filtro de IP:

```bash
curl -s https://mcp.famachat.com.br/health
```

```json
{"status":"ok","server":{"name":"famachat","version":"1.0.0"},
 "tools":277,"backendCommit":"e1acfed","uptimeSeconds":1368}
```

Se isso responde, o servidor está no ar e o problema é do lado do cliente.

| Sintoma | Causa |
|---|---|
| `401` | O header `Authorization` não chegou ao servidor |
| `403` com `INVALID_TOKEN` | Senha errada — confira o passo 0 |
| `403` com `IP_NOT_ALLOWED` | Seu IP não está na allowlist do servidor |
| Nenhuma ferramenta aparece | O cliente não reconectou. Reinicie-o |
| Conexão recusada ou timeout | Se nem o `/health` responde, o servidor está fora — avise quem administra |
| Ferramenta responde `404` | A rota mudou no CRM e o catálogo está velho — avise quem administra |

O corpo da resposta de erro diz qual foi o caso:

```json
{"jsonrpc":"2.0","error":{"code":-32001,"message":"Origem não autorizada",
 "data":{"code":"IP_NOT_ALLOWED"}},"id":null}
```
