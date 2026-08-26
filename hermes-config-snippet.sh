#!/bin/bash
# Imprime o bloco pronto para colar em ~/.hermes/config.yaml no VPS do Hermes.
#
# O token vive só no .env deste servidor. Rode aqui e copie a saída:
#   bash /var/www/mcp-famachat/hermes-config-snippet.sh
set -euo pipefail

KEY=$(grep -oP '(?<=^MCP_API_KEY=).*' /var/www/mcp-famachat/.env)

cat <<YAML
mcp_servers:
  famachat:
    url: "https://mcp.famachat.com.br/mcp"
    headers:
      Authorization: "Bearer ${KEY}"
    timeout: 180
    connect_timeout: 30
YAML
