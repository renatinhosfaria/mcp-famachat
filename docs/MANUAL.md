# Manual de Uso

O que você consegue fazer no FamaChat através do agente, e como pedir.

Se ainda não conectou seu cliente, comece pelo [Guia de Instalação](INSTALACAO.md).

---

## O que o agente passa a enxergar

277 ferramentas, em duas famílias que se comportam de maneira bem diferente. Entender a
diferença é o que separa um pedido que funciona de um que dá resultado estranho.

### `fc_*` — os endpoints do CRM

Uma ferramenta para cada rota do FamaChat: 271 no total, em 41 módulos. Cada chamada passa
pelo sistema como se fosse alguém usando a tela — e portanto **dispara as regras de
negócio**: rotação de leads por SLA Cascata, eventos de Meta CAPI, webhooks de saída,
validações.

É o caminho certo para **criar e alterar**. Um cliente criado assim entra no funil como
qualquer outro.

### `db_*` — o banco de dados direto

Cinco ferramentas que falam com o PostgreSQL sem passar pelo CRM. Servem para
**consultar**: relatórios, contagens, cruzamentos que nenhuma tela oferece.

Escritas aqui **não disparam nada** — nem CAPI, nem webhook, nem rotação de lead.

### A regra curta

> **Ler pelo banco, escrever pelo endpoint.**

---

## Como pedir as coisas

Você conversa em português normal. O agente escolhe a ferramenta. Alguns exemplos do que
funciona bem:

**Consultas e relatórios**

> Quantos clientes estão em atendimento agora?

> Me dê os 10 clientes mais recentes com nome, telefone e corretor responsável.

> Quantos leads vieram do Facebook Ads este mês, comparado ao mês passado?

> Quais corretores têm mais clientes ativos?

> Quantas visitas foram agendadas esta semana?

**Buscar algo específico**

> Procure o cliente com telefone (34) 99999-1234.

> Mostre o histórico de anotações do cliente 12790.

> Esse cliente tem alguma visita marcada?

**Criar e alterar**

> Crie um cliente: Maria Silva, (34) 99999-1234, veio pelo WhatsApp.

> Mude o status do cliente 12790 para Em Atendimento.

> Agende uma visita para o cliente 12790 na próxima terça às 14h.

**Entender a estrutura**

> Que ferramentas existem para trabalhar com imóveis?

> Quais campos a tabela de clientes tem?

Quando o pedido for ambíguo, o agente vai perguntar em vez de adivinhar — principalmente
se envolver alterar ou apagar dados.

---

## O catálogo de ferramentas

Com 271 endpoints, o agente não decora nomes: ele consulta `fc_catalog`, o índice.

Você pode pedir isso diretamente quando quiser saber o que existe:

> Liste os módulos disponíveis no FamaChat.

```
271 endpoints do FamaChat em 41 módulos

Rotas por módulo:
   38  whatsapp
   30  empreendimentos-page
   13  clientes
   12  agenda
   11  arquivos
   10  proprietarios
   10  sla-cascata
   ...
```

> Que ferramentas existem no módulo clientes?

```
GET    /api/clientes            →  fc_get_clientes
POST   /api/clientes            →  fc_post_clientes
GET    /api/clientes/:id        →  fc_get_clientes_by_id
PATCH  /api/clientes/:id        →  fc_patch_clientes_by_id
DELETE /api/clientes/:id        →  fc_del_clientes_by_id
GET    /api/clientes/:id/notes  →  fc_get_clientes_by_id_notes
...
```

A busca entende português mesmo quando a rota está em inglês: procurar `agendamento` acha
`/api/appointments`, `venda` acha `/api/sales`, `painel` acha `/api/dashboard`. Acentos e
plural também — `imóveis` acha casas, apartamentos e terrenos.

### Os módulos

| Módulo | Cobre |
|---|---|
| `clientes` | O funil comercial — criar, atualizar, notas, empreendimentos de interesse |
| `agenda` | Agendamentos e visitas |
| `leads` | Leads captados e conversão em cliente |
| `sales` | Vendas |
| `sla-cascata` | Rotação automática de leads entre corretores |
| `automation` | Regras de distribuição de leads |
| `whatsapp` | Instâncias, conexão, envio e status |
| `empreendimentos-page`, `apartamentos-novo`, `casas`, `terrenos`, `imoveis` | Catálogo imobiliário |
| `proprietarios`, `construtoras` | Cadastros de origem dos imóveis |
| `dashboard`, `dashboard-gestor`, `metrics` | Indicadores e ranking de corretores |
| `users`, `horarios-usuario` | Corretores e suas escalas |
| `arquivos`, `storage-admin`, `midia-upload` | Gerenciador de arquivos |
| `auth` | Autenticação |
| `webhooks/*` | Webhooks de entrada e saída |

---

## O que o agente vê ao chamar uma ferramenta

Você não precisa saber disso para usar, mas ajuda a interpretar quando algo dá errado.

Cada ferramenta `fc_*` recebe os parâmetros da rota, um `query` opcional e, quando faz
sentido, um `body`:

```jsonc
fc_get_clientes({ query: { limit: 20, status: "Em Atendimento" } })
fc_get_clientes_by_id({ id: 12790 })
fc_patch_clientes_by_id({ id: 12790, body: { status: "Em Atendimento" } })
```

E devolve o status HTTP junto com a resposta crua do CRM:

```json
{ "status": 200, "statusText": "OK", "truncated": false, "body": { "data": [ ... ] } }
```

As consultas ao banco vêm assim:

```
comando: SELECT | linhas afetadas/retornadas: 3 | duração: 588ms

[ { "id": 12790, "full_name": "Maria Silva", "status": "Em Atendimento" } ]
```

Um detalhe que às vezes confunde: o banco usa `snake_case` (`full_name`) e a API do CRM
usa `camelCase` (`fullName`). É o mesmo dado, com nome diferente conforme o caminho.

---

## As tabelas do banco

Para consultas, é útil saber onde as coisas moram:

| Tabela | Guarda |
|---|---|
| `clientes` | O funil comercial — o coração do CRM |
| `clientes_id_anotacoes` | Histórico e notas de cada cliente |
| `clientes_agendamentos` | Compromissos da agenda |
| `clientes_visitas` | Visitas a imóveis |
| `sistema_users` | Corretores e gestores |
| `sistema_leads` | Leads captados |
| `sistema_leads_sla_cascata` | Rotação de leads pelo SLA Cascata |
| `imoveis_empreendimentos`, `imoveis_apartamentos` | Catálogo imobiliário |

Não precisa decorar. Peça:

> Quais campos a tabela clientes tem?

e o agente traz colunas, tipos, constraints e índices.

---

## Cuidados

O agente tem acesso irrestrito ao CRM e ao banco. Três situações pedem atenção:

**Alterar a estrutura do banco.** Comandos como `DROP TABLE` ou `ALTER TABLE` não mexem em
um registro: mudam o esqueleto de que o FamaChat depende para funcionar. `DROP TABLE
clientes` não apaga um cliente — apaga todos e a própria tabela.

**Alteração em massa.** Um "atualize o status de todos os clientes" atinge a base inteira.
Vale conferir o número de linhas antes: peça a contagem primeiro, depois a alteração.

**Exclusões.** Apagar cliente, lead ou agendamento remove de verdade.

> ⚠️ **Não há como desfazer.** O banco de produção não tem backup automático funcionando
> hoje: não existe point-in-time recovery, e a rotina de backup que roda no servidor cobre
> outro banco. Na prática, um comando destrutivo não tem de onde ser restaurado. Trate
> exclusões e alterações em massa com o cuidado que isso exige.

O agente foi instruído a confirmar antes de operações destrutivas, mas a instrução é um
pedido, não uma trava.

**Tudo fica registrado.** Cada chamada de ferramenta vira uma linha num log de auditoria
no servidor: qual ferramenta, com que argumentos, qual SQL, quantas linhas, quanto tempo,
e se deu erro. Se algo estranho acontecer, dá para reconstruir exatamente o que foi feito.

---

## Escrever pelo banco ou pelo endpoint?

| Situação | Caminho |
|---|---|
| Criar cliente, lead, agendamento, venda | **Endpoint** — as regras de negócio precisam rodar |
| Mudar status de cliente no funil | **Endpoint** — dispara Meta CAPI e webhooks |
| Relatório, contagem, cruzamento | **Banco** — muito mais direto |
| Buscar algo que nenhuma tela filtra | **Banco** |
| Corrigir centenas de linhas de uma vez | **Banco**, ciente de que nada é disparado |

Se você não disser nada, o agente escolhe — e a escolha padrão dele é a certa. Vale ser
explícito quando importar:

> Crie esse cliente **pelo endpoint**, para entrar na rotação normal.

> Faça essa correção **direto no banco**, sem disparar webhook.

---

## Limites

| Limite | Valor |
|---|---|
| Linhas por consulta ao banco | 1000 |
| Duração de uma consulta | 30 segundos |
| Duração de uma chamada ao CRM | 60 segundos |
| Tamanho da resposta do CRM | 1 MB |

Estourar um limite não quebra nada: o resultado volta marcado como truncado, ou o erro
explica o que houve. Quando acontecer, estreite o pedido — filtre por período, por
corretor, por status — em vez de pedir tudo de novo.

Duas coisas que **não** dá para fazer por aqui: enviar arquivos binários (fotos, vídeos,
PDFs — os endpoints de mídia esperam upload de formulário, e as ferramentas mandam JSON)
e acompanhar resultado em tempo real, já que toda resposta chega inteira, de uma vez.

---

## Perguntas frequentes

**As ações do agente aparecem como de quem no FamaChat?**
De um usuário próprio, `hermes-agent`, com papel de Gestor. Ele aparece nos logs e como
responsável nos registros que criar — separado das pessoas de verdade.

**O agente pode ver tudo?**
Sim. O papel Gestor cobre praticamente todo o sistema. Algumas rotas checam departamento
além do papel; nesses casos a resposta diz qual permissão faltou.

**Uma ferramenta respondeu 404. E agora?**
A rota mudou no CRM e o catálogo do servidor está desatualizado. Avise quem administra o
servidor — é um comando para regenerar.

**Uma ferramenta respondeu 403.**
Ou é permissão no CRM (a resposta diz qual), ou o seu IP não está liberado no servidor.

**Dá para limitar o que o agente enxerga?**
Sim, e é configuração do lado do cliente, não do servidor. No Hermes, `tools.include` ou
`tools.exclude` no `config.yaml` recortam o conjunto. Útil se o agente começar a se
confundir entre as 277.

**O servidor lembra do que eu pedi antes?**
Não. Cada chamada é independente. A memória da conversa é do seu agente, não do servidor.
