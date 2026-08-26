# Guia de Instalação

Como levantar o MCP server do FamaChat do zero, em um servidor novo, e conectar o Hermes
Agent a ele.

Se o servidor já está instalado e você só quer operá-lo, veja o [Manual de Uso](MANUAL.md).

---

## Antes de começar

**No servidor onde o MCP vai rodar:**

| Requisito | Por quê |
|---|---|
| Node 22 ou superior | O servidor usa `--env-file` nativo e `fetch` global |
| pnpm 10 | Gerenciador do projeto; `npm i -g pnpm` resolve |
| nginx | Termina o TLS e faz proxy para a porta local |
| certbot | Emite o certificado Let's Encrypt |
| PM2 | Mantém o processo vivo e o resobe no boot |
| Acesso ao backend do FamaChat | Por padrão em `http://127.0.0.1:5000` |
| Acesso ao PostgreSQL de produção | Host, porta, usuário e senha |

**Fora do servidor:**

- Um subdomínio apontando para o IP do servidor. Em produção é `mcp.famachat.com.br`.
  Confirme antes de emitir o certificado — o certbot falha se o DNS ainda não propagou:
  ```bash
  getent hosts mcp.famachat.com.br
  ```
- O IP do VPS onde o Hermes roda, se você for usar a allowlist (recomendado).

---

## 1. Código e dependências

```bash
git clone https://github.com/renatinhosfaria/mcp-famachat.git /var/www/mcp-famachat
cd /var/www/mcp-famachat
pnpm install
```

## 2. Manifesto de rotas

As ferramentas `fc_*` saem de `routes/backend-routes.json`, gerado a partir do código do
backend. O arquivo vem versionado, mas regenere para casar com o commit que está rodando:

```bash
pnpm gen:routes                          # assume /var/www/famachat
pnpm gen:routes -- --source /outro/caminho   # se o backend estiver em outro lugar
```

A saída informa quantas rotas foram encontradas e de qual commit:

```
Manifesto gerado em routes/backend-routes.json
271 rotas (15 aliases) de 41 módulos — commit e1acfed
```

Se o número vier muito abaixo do esperado, o gerador não achou o `server/routes.ts` — o
caminho de `--source` deve ser a **raiz** do repositório do FamaChat, não a pasta `server`.

## 3. Arquivo de configuração

```bash
cp .env.example .env
chmod 600 .env
```

Preencha:

```bash
# A senha que o Hermes vai enviar. Gere um valor novo, não reaproveite:
openssl rand -hex 32
```

| Variável | Valor |
|---|---|
| `MCP_API_KEY` | O hex de 32 bytes recém-gerado. Mínimo de 32 caracteres, senão o servidor recusa subir |
| `DATABASE_URL` | A mesma string de conexão do backend — copie de `/var/www/famachat/.env` |
| `FAMACHAT_API_URL` | `http://127.0.0.1:5000` quando backend e MCP dividem o servidor |
| `FAMACHAT_SERVICE_EMAIL` | `hermes-agent@famachat.com.br` |
| `FAMACHAT_SERVICE_PASSWORD` | Preencha no passo 4 |
| `MCP_IP_ALLOWLIST` | Deixe vazio por ora; ligue no passo 8 |

## 4. Usuário de serviço

O MCP não usa a credencial de nenhuma pessoa: ele se autentica no backend como um usuário
próprio, `hermes-agent`, com papel `Gestor`. Isso mantém as ações do agente separadas das
de gente de verdade nos logs e no funil — e permite cortar o acesso dele sem trocar a
senha de ninguém.

```bash
pnpm provision:user
```

O script cria o usuário e imprime a senha **uma única vez**. Copie para o `.env`.

Se o usuário já existir e você quiser uma senha nova:

```bash
pnpm provision:user --rotate
```

O `--rotate` também incrementa o `token_version` do usuário, o que invalida qualquer JWT
antigo. O MCP refaz o login sozinho na chamada seguinte.

> Para não deixar a senha no histórico do shell, grave direto no arquivo:
> ```bash
> OUT=$(pnpm provision:user --rotate 2>&1)
> export PASS=$(printf '%s' "$OUT" | grep -oP '(?<=^FAMACHAT_SERVICE_PASSWORD=).*')
> python3 -c "
> import os,re
> s=open('.env').read()
> s=re.sub(r'^FAMACHAT_SERVICE_PASSWORD=.*$','FAMACHAT_SERVICE_PASSWORD='+os.environ['PASS'],s,flags=re.M)
> open('.env','w').write(s)"
> unset PASS OUT
> ```

## 5. Build e primeira subida

```bash
pnpm build
pnpm test          # 75 testes; se algum falhar, pare aqui
pnpm start
```

O boot imprime o que foi carregado:

```
[INFO] PostgreSQL conectado {"identidade":"postgres@neondb"}
[INFO] MCP server no ar {"url":"http://127.0.0.1:5100/mcp","ferramentas":277,
       "endpoints":271,"backendCommit":"e1acfed","modo":"stateless",
       "usuarioDeServico":"hermes-agent@famachat.com.br","ipAllowlist":"desligada"}
```

O servidor **falha na partida** se faltar configuração, se o banco não responder ou se o
manifesto estiver ausente. Isso é intencional: melhor não subir do que subir quebrado e
só descobrir na primeira chamada do agente.

Confira em outro terminal e depois pare com `Ctrl+C`:

```bash
curl -s http://127.0.0.1:5100/health
```

## 6. PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup      # só na primeira vez no servidor, para resubir no boot
```

O `ecosystem.config.cjs` já passa `--env-file=.env` ao Node. O app se chama
**`mcp-famachat`** — não confunda com `famachat-backend`, que é o CRM.

## 7. nginx e TLS

Crie `/etc/nginx/sites-available/mcp.famachat.com.br`. O arquivo em produção está no
servidor; o essencial é:

```nginx
server {
    server_name mcp.famachat.com.br;
    client_max_body_size 25m;

    location / { return 404; }

    location = /health {
        proxy_pass http://127.0.0.1:5100/health;
        proxy_set_header X-Real-IP $remote_addr;
        access_log off;
    }

    location = /mcp {
        proxy_pass http://127.0.0.1:5100/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass_request_headers on;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    listen 80;
    listen [::]:80;
}
```

Três linhas que não são decorativas:

- **`proxy_buffering off`** — o Streamable HTTP pode responder em SSE. Com buffering, a
  resposta só chegaria ao Hermes no final.
- **`proxy_set_header X-Real-IP $remote_addr`** — é daqui que a allowlist tira o IP real.
  Sem esse header, ela cai no `X-Forwarded-For`, que o cliente consegue influenciar.
- **`proxy_read_timeout 300s`** — uma tool call pode consultar o banco por bastante tempo.

Ative e emita o certificado:

```bash
ln -sfn /etc/nginx/sites-available/mcp.famachat.com.br /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d mcp.famachat.com.br --redirect
```

O certbot reescreve o arquivo acrescentando o bloco `listen 443 ssl` e a redireção de 80
para 443. A renovação automática já vem configurada.

## 8. Allowlist de IP

Restringe quem pode falar com `/mcp`, mesmo com o token correto:

```bash
# VPS do Hermes, mais este servidor e o loopback para diagnóstico
sed -i 's|^MCP_IP_ALLOWLIST=.*|MCP_IP_ALLOWLIST=169.58.161.112,173.249.13.241,127.0.0.1|' .env
pm2 restart mcp-famachat --update-env
```

Se você listar **apenas** o IP do Hermes, perde a capacidade de testar o `/mcp` a partir
do próprio servidor — todo diagnóstico terá de sair do VPS do Hermes. O `/health`
continua acessível de qualquer lugar, sem token e sem filtro.

## 9. Rotação do log de auditoria

```bash
cat > /etc/logrotate.d/mcp-famachat <<'EOF'
/var/www/mcp-famachat/logs/audit.jsonl {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    create 0600 root root
}
EOF
logrotate -d /etc/logrotate.d/mcp-famachat   # simula, não aplica
```

Noventa dias é mais que um log comum guarda de propósito: como o agente tem permissão
irrestrita no banco, essa é a única trilha do que ele fez.

## 10. Verificação de ponta a ponta

```bash
KEY=$(grep -oP '(?<=^MCP_API_KEY=).*' .env)
URL=https://mcp.famachat.com.br/mcp
```

**Autenticação** — os dois primeiros devem falhar:

```bash
curl -s -o /dev/null -w "sem token:    %{http_code}\n" -X POST $URL \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# esperado: 401

curl -s -o /dev/null -w "token errado: %{http_code}\n" -X POST $URL \
  -H "Authorization: Bearer errado" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# esperado: 403
```

**Handshake e catálogo:**

```bash
curl -s -X POST $URL -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# esperado: protocolVersion + serverInfo {"name":"famachat"}

curl -s -X POST $URL -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name"' | wc -l
# esperado: o número de ferramentas (277 hoje)
```

**Backend e banco:**

```bash
# valida o login do usuário de serviço
curl -s -X POST $URL -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fc_get_auth_me","arguments":{}}}'
# esperado: username "hermes-agent", role "Gestor"

curl -s -X POST $URL -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"db_query","arguments":{"sql":"SELECT count(*) FROM clientes"}}}'
# esperado: a contagem de clientes
```

## 11. Conectar o Hermes

No servidor do MCP, gere o bloco de configuração com o token já preenchido:

```bash
bash /var/www/mcp-famachat/hermes-config-snippet.sh
```

Cole a saída em `~/.hermes/config.yaml`, no VPS do Hermes:

```yaml
mcp_servers:
  famachat:
    url: "https://mcp.famachat.com.br/mcp"
    headers:
      Authorization: "Bearer <MCP_API_KEY>"
    timeout: 180
    connect_timeout: 30
```

Reinicie o daemon do Hermes. Ele abre a conexão uma vez no boot, faz `initialize` e
`tools/list`, e registra as ferramentas.

Verificado contra o Hermes **0.20.5**: o preflight de content-type passa (o `/mcp`
responde 405 em HEAD e GET, e o preflight só rejeita respostas 2xx com content-type
não-MCP), o keepalive por `ping` JSON-RPC é respondido mesmo em modo stateless, e a
negociação de versão do protocolo funciona.

Para confirmar que o Hermes conectou, olhe o log dele — ou peça ao agente que chame
`fc_catalog`.

---

## Quando algo dá errado

| Sintoma | Causa provável |
|---|---|
| `Configuração inválida` na partida | Falta variável no `.env`, ou o `MCP_API_KEY` tem menos de 32 caracteres. A mensagem lista o campo |
| `Manifesto de rotas não encontrado` | Faltou `pnpm gen:routes` |
| Falha ao conectar no PostgreSQL | `DATABASE_URL` errada, ou o IP do servidor não está liberado no Postgres remoto |
| `401` com o token certo | O header não chegou. Confira `proxy_pass_request_headers on` no nginx |
| `403 IP_NOT_ALLOWED` | O IP de origem não está em `MCP_IP_ALLOWLIST`. Veja qual chegou em `logs/audit.jsonl` |
| Ferramenta `fc_*` devolve 401 | O usuário de serviço foi desativado ou teve a senha trocada. Rode `pnpm provision:user --rotate` e atualize o `.env` |
| Ferramenta `fc_*` devolve 404 | A rota mudou no backend. Rode `pnpm gen:routes && pnpm build && pm2 restart mcp-famachat` |
| O Hermes não lista as ferramentas | Veja `pm2 logs mcp-famachat`. Se nem chega requisição, o problema é DNS, TLS ou allowlist |

Logs:

```bash
pm2 logs mcp-famachat --lines 50     # aplicação
tail -f logs/audit.jsonl             # o que o agente fez
```
