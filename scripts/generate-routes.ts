#!/usr/bin/env tsx
/**
 * Gerador do manifesto de rotas do backend do FamaChat.
 *
 * O backend registra rotas em dois estilos que coexistem:
 *
 *   1. `app.get('/api/clientes/:id', ...)` — path absoluto, dentro de uma função
 *      `registerXRoutes(app)` (padrão de server/routes/clientes.ts, users.ts, ...).
 *   2. `router.get('/:id', ...)` — path relativo a um prefixo definido lá em
 *      `server/routes.ts` via `app.use('/api/leads', leadsRoutes)`.
 *
 * Resolver o segundo caso exige seguir o import do identificador até o arquivo de
 * origem, então a varredura é feita sobre a AST do TypeScript, não com regex.
 *
 * Uso: pnpm gen:routes [--source /var/www/famachat] [--out routes/backend-routes.json]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Arquivos que declaram `.get(...)` mas não são rotas HTTP do Express. */
const NOT_HTTP_ROUTES = /cache-invalidation\.service\.ts$/;

export type RouteEntry = {
  method: string;
  route: string;
  sourceFile: string;
  sourceLine: number;
  module: string;
  pathParams: string[];
  optionalParams: string[];
  alias: boolean;
};

export type RouteManifest = {
  version: number;
  sourceRoot: string;
  sourceCommit: string;
  generatedAt: string;
  counts: { total: number; unique: number; aliases: number };
  routes: RouteEntry[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Varredura de arquivos
// ─────────────────────────────────────────────────────────────────────────────

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...listTsFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    if (NOT_HTTP_ROUTES.test(full)) continue;
    out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Extrai o literal de string de um argumento, se ele for um. */
function stringLiteral(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passo 1 — mapa de prefixos declarados em server/routes.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `import X from './routes/leads'` / `import { agendaRouter } from './modules/agenda'`
 * para o caminho absoluto do arquivo, incluindo `index.ts` de diretório.
 */
function buildImportMap(sf: ts.SourceFile, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();

  const resolveSpecifier = (spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(baseDir, spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const spec = stringLiteral(stmt.moduleSpecifier);
    if (!spec) continue;
    const file = resolveSpecifier(spec);
    if (!file) continue;

    const clause = stmt.importClause;
    if (clause.name) map.set(clause.name.text, file);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) map.set(el.name.text, file);
    }
  }
  return map;
}

/**
 * Segue re-exports até o arquivo que de fato declara o router.
 *
 * `server/modules/agenda/index.ts` só faz
 * `export { agendaRouter } from './routes/agenda.routes'` — parar no index
 * perderia todas as rotas de agendamentos e visitas do módulo.
 */
function resolveReexport(file: string, symbol: string, depth = 0): string {
  if (depth > 5) return file;

  const sf = parse(file);
  const baseDir = dirname(file);

  const resolveSpecifier = (spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(baseDir, spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
    const target = resolveSpecifier(stringLiteral(stmt.moduleSpecifier) ?? '');
    if (!target) continue;

    // `export { agendaRouter } from './routes/agenda.routes'`
    if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text !== symbol) continue;
        // Com alias (`export { x as y }`), o nome no arquivo de origem é o original.
        const original = el.propertyName?.text ?? symbol;
        return resolveReexport(target, original, depth + 1);
      }
      continue;
    }

    // `export * from './x'` — o símbolo pode estar em qualquer um dos alvos.
    if (!stmt.exportClause) {
      const found = resolveReexport(target, symbol, depth + 1);
      if (found !== target || collectRouterIdentifiers(parse(target)).has(symbol)) return found;
    }
  }

  return file;
}

/**
 * Percorre o grafo de registro a partir de `server/routes.ts`, coletando os
 * arquivos alcançáveis e o prefixo sob o qual cada um é montado.
 *
 * Varrer `server/**` inteiro seria mais simples e estaria errado: o backend tem
 * arquivos de rota órfãos — `server/routes/appointments.ts` não é importado por
 * ninguém, e suas rotas não existem em runtime. Gerar ferramentas para elas daria
 * ao agente dezenas de ações que sempre respondem 404.
 *
 * Duas formas de registro são seguidas:
 *   • `app.use('/api/leads', leadsRoutes)` — monta um router sob um prefixo;
 *   • `registerClienteRoutes(app)` — a função registra rotas de path absoluto,
 *     e pode chamar outras funções de registro (webhooks/index.ts faz isso).
 */
function collectReachableFiles(routesFile: string): Map<string, string[]> {
  const reachable = new Map<string, string[]>();
  const queue: { file: string; prefix: string }[] = [{ file: routesFile, prefix: '' }];
  const visited = new Set<string>();

  const remember = (file: string, prefix: string): void => {
    const list = reachable.get(file) ?? [];
    if (!list.includes(prefix)) list.push(prefix);
    reachable.set(file, list);
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const key = `${current.file}::${current.prefix}`;
    if (visited.has(key)) continue;
    visited.add(key);
    remember(current.file, current.prefix);

    const sf = parse(current.file);
    const imports = buildImportMap(sf, dirname(current.file));

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;

        // app.use('<prefixo>', router)
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'use' &&
          ts.isIdentifier(callee.expression)
        ) {
          const prefix = stringLiteral(node.arguments[0]);
          if (prefix?.startsWith('/api')) {
            for (const arg of node.arguments.slice(1)) {
              if (!ts.isIdentifier(arg)) continue;
              const imported = imports.get(arg.text);
              if (imported) queue.push({ file: resolveReexport(imported, arg.text), prefix });
            }
          }
        }

        // registerXRoutes(app) — a função vive em outro arquivo importado.
        if (ts.isIdentifier(callee)) {
          const imported = imports.get(callee.text);
          if (imported) {
            queue.push({ file: resolveReexport(imported, callee.text), prefix: current.prefix });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return reachable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passo 2 — chamadas de método HTTP em cada arquivo
// ─────────────────────────────────────────────────────────────────────────────

type RawCall = { method: string; path: string; line: number; receiver: string };

/**
 * Identificadores do arquivo que são routers Express de verdade — declarados como
 * `Router()` ou `express.Router()`. Sem isso, um cliente HTTP como o `whatsappApi`
 * de server/services/whatsapp-api.ts entraria no manifesto: ele também responde a
 * `.get('...', config)` e é indistinguível de um router por forma da chamada.
 */
function collectRouterIdentifiers(sf: ts.SourceFile): Set<string> {
  const routers = new Set<string>();

  const isRouterFactory = (init: ts.Expression | undefined): boolean => {
    if (!init || !ts.isCallExpression(init)) return false;
    const callee = init.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'Router';
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'Router';
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isRouterFactory(node.initializer)) routers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return routers;
}

/**
 * Parâmetros tipados como `Express` ou `Router`, que também recebem rotas:
 * `registerClienteRoutes(app: Express)` e `registerWebhookRoutes(router: Router)`.
 */
function collectRouterParameters(sf: ts.SourceFile): Set<string> {
  const params = new Set<string>();
  const ROUTER_TYPES = new Set(['Express', 'Router', 'Application', 'IRouter']);

  const scanParams = (node: ts.SignatureDeclarationBase): void => {
    for (const param of node.parameters) {
      if (!ts.isIdentifier(param.name) || !param.type) continue;
      const type = param.type;
      if (!ts.isTypeReferenceNode(type)) continue;
      // `Express` e também a forma qualificada `express.Express`.
      const name = ts.isIdentifier(type.typeName)
        ? type.typeName.text
        : type.typeName.right.text;
      if (ROUTER_TYPES.has(name)) params.add(param.name.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      scanParams(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return params;
}

/**
 * Prefixos de routers montados dentro do próprio arquivo:
 * `registerOgImageRoutes(app)` faz `app.use('/api/og-image', router)`, e sem isso
 * as rotas declaradas em `router` ficariam sem prefixo — e de fora do manifesto.
 */
function collectLocalMounts(sf: ts.SourceFile): Map<string, string[]> {
  const locals = collectRouterIdentifiers(sf);
  const mounts = new Map<string, string[]>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use'
    ) {
      const prefix = stringLiteral(node.arguments[0]);
      if (prefix?.startsWith('/api')) {
        for (const arg of node.arguments.slice(1)) {
          if (!ts.isIdentifier(arg) || !locals.has(arg.text)) continue;
          const list = mounts.get(arg.text) ?? [];
          if (!list.includes(prefix)) list.push(prefix);
          mounts.set(arg.text, list);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return mounts;
}

function collectHttpCalls(sf: ts.SourceFile): RawCall[] {
  const routers = new Set([...collectRouterIdentifiers(sf), ...collectRouterParameters(sf)]);
  const calls: RawCall[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const method = node.expression.name.text.toLowerCase();
      const receiver = node.expression.expression.text;
      const path = stringLiteral(node.arguments[0]);
      // Uma rota tem sempre ao menos um handler além do path.
      if (
        HTTP_METHODS.has(method) &&
        path !== null &&
        node.arguments.length >= 2 &&
        routers.has(receiver)
      ) {
        calls.push({ method: method.toUpperCase(), path, line: lineOf(sf, node), receiver });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Montagem do manifesto
// ─────────────────────────────────────────────────────────────────────────────

function joinPath(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, '');
  const right = path === '/' ? '' : path;
  const joined = `${left}${right.startsWith('/') || right === '' ? '' : '/'}${right}`;
  return joined.replace(/\/{2,}/g, '/') || '/';
}

/**
 * Separa os parâmetros da rota. O Express aceita `:nome?` (opcional) e `*`
 * (wildcard) — ambos aparecem no backend e precisam ser distinguidos, senão o
 * nome do parâmetro sai com o `?` colado e o wildcard some sem substituto.
 */
export function extractRouteParams(route: string): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const match of route.matchAll(/:([A-Za-z0-9_]+)(\?)?/g)) {
    (match[2] ? optional : required).push(match[1] as string);
  }
  if (route.includes('*')) required.push(WILDCARD_PARAM);
  return { required, optional };
}

/** Nome dado ao segmento `*` de uma rota wildcard. */
export const WILDCARD_PARAM = 'wildcard';

function moduleNameFor(relPath: string): string {
  const m = /^server\/routes\/(.+)\.ts$/.exec(relPath);
  if (m) return (m[1] as string).replace(/\.routes$/, '');
  const mod = /^server\/modules\/([^/]+)\//.exec(relPath);
  if (mod) return mod[1] as string;
  return relPath.replace(/^server\//, '').replace(/\.ts$/, '');
}

export function buildManifest(sourceRoot: string): RouteManifest {
  const serverDir = join(sourceRoot, 'server');
  const routesFile = join(serverDir, 'routes.ts');
  if (!existsSync(routesFile)) {
    throw new Error(`server/routes.ts não encontrado em ${sourceRoot}`);
  }

  const reachable = collectReachableFiles(routesFile);
  const seen = new Map<string, RouteEntry>();
  const routes: RouteEntry[] = [];

  for (const [file, prefixes] of reachable) {
    if (!existsSync(file)) continue;
    const sf = parse(file);
    const relPath = relative(sourceRoot, file);

    const localMounts = collectLocalMounts(sf);

    for (const call of collectHttpCalls(sf)) {
      // Paths absolutos (`app.get('/api/...')`) valem por si; os demais só
      // existem sob o prefixo em que o router foi montado — no próprio arquivo
      // ou lá em routes.ts.
      const mountPrefixes = localMounts.get(call.receiver) ?? prefixes.filter((p) => p !== '');
      const fullPaths = call.path.startsWith('/api')
        ? [call.path]
        : mountPrefixes.map((p) => joinPath(p, call.path));

      if (fullPaths.length === 0) continue;

      for (const [index, route] of fullPaths.entries()) {
        const key = `${call.method} ${route}`;
        if (seen.has(key)) continue;
        const params = extractRouteParams(route);
        const entry: RouteEntry = {
          method: call.method,
          route,
          sourceFile: relPath,
          sourceLine: call.line,
          module: moduleNameFor(relPath),
          pathParams: params.required,
          optionalParams: params.optional,
          alias: index > 0,
        };
        seen.set(key, entry);
        routes.push(entry);
      }
    }
  }

  routes.sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));

  let sourceCommit = 'unknown';
  try {
    sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      // Fixtures de teste não são repositórios; o aviso do git só polui a saída.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Repositório indisponível — o manifesto continua válido.
  }

  const aliases = routes.filter((r) => r.alias).length;
  return {
    version: 1,
    sourceRoot,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    counts: { total: routes.length, unique: routes.length - aliases, aliases },
    routes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceRoot = resolve(argValue('--source', '/var/www/famachat'));
  const outPath = resolve(projectRoot, argValue('--out', 'routes/backend-routes.json'));

  const manifest = buildManifest(sourceRoot);
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const byModule = new Map<string, number>();
  for (const r of manifest.routes) byModule.set(r.module, (byModule.get(r.module) ?? 0) + 1);

  console.log(`Manifesto gerado em ${relative(projectRoot, outPath)}`);
  console.log(
    `${manifest.counts.total} rotas (${manifest.counts.aliases} aliases) de ${byModule.size} módulos — commit ${manifest.sourceCommit}`
  );
}
