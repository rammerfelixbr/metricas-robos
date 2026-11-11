#!/usr/bin/env node
// Radar diário de pautas em alta (pedido do Rammer em 15/10/2026: "conteúdo em alta, que vale artigo porque está
// viralizando; tem que ter timing, ser rápido; pesquisando e encontrando tudo de forma automática").
//
// Roda no Mac (launchd a cada 30 min; decide sozinho a hora: 1ª passagem a partir das 09:00, uma vez por dia; tenta
// de novo em 2 h se falhar). O que faz:
//   1. GET /api/radar: contexto de cada projeto (território, consultas do Google, posts recentes, pautas já enfileiradas).
//   2. Lê o Google Trends (BR, diário) e o Google News do território de cada projeto (termos em TERMOS abaixo).
//   3. Claude (Opus, contas do Keychain) decide 0 ou 1 pauta URGENTE por projeto: só o que está em alta HOJE e cabe no
//      território (lê o CLAUDE.md e o pautas.md de cada projeto, só leitura).
//   4. Para cada pauta: insere NO TOPO da tabela do pautas.md do projeto (status "livre", marcada "urgente, radar"),
//      commit + push em main, e dispara o robô de posts (GitHub: `gh workflow run`; blog EN: o cron do servidor faz
//      git pull antes de gerar). Os robôs pegam "a PRIMEIRA pauta livre": a urgente sai no mesmo dia.
//   5. POST /api/radar com as pautas (vira linha nas Decisões do projeto e na aba Contatos). No dia seguinte, confere
//      o pautas.md e avisa quais viraram post; 14 dias depois o painel mede impressões/cliques/visitas do post.
// Token: Keychain "Métricas - token de revisão". Log: ~/Library/Logs/metricas-radar.log. Na mão: `node robo/radar.mjs --agora`.
import { execFileSync } from "node:child_process";
import { rodarClaudeComContas } from "./contas.mjs";
import { NA_NUVEM, PROJETOS_CASA, TRABALHO, gh as ghNuvem, pastaDoProjeto } from "./nuvem.mjs";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const CASA = homedir();
const SITE = process.env.METRICAS_URL ?? "https://metricas.rammerfelix.workers.dev";
const MODELO = process.env.METRICAS_MODELO ?? "opus";
// Na nuvem (GitHub Actions, 11/11/2026) os projetos são clonados em trabalho/meus-clientes/<id>; no Mac, as pastas de sempre.
const CLIENTES = process.env.CLIENTES_DIR ?? TRABALHO;
const TEMPO_MAX_MS = 15 * 60 * 1000;
const LOCK = join(AQUI, "lock-radar");
const MARCA_DIA = join(AQUI, "ultimo-radar.txt");
const PENDENTE = join(AQUI, "radar-pendente.txt");
const TENTAR_DE_NOVO_MS = 2 * 60 * 60 * 1000;
const HORA_MINIMA = 9 * 60;
const ESQUEMA = readFileSync(join(AQUI, "esquema-radar.json"), "utf8");
const SO_LER = process.argv.includes("--so-ler");
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Termos do território de cada projeto para o Google News (o Trends é geral). Ajustar aqui quando um projeto mudar.
const TERMOS = {
  "guia-do-certificado": ["certificado curso", "horas complementares", "prova de títulos concurso", "formação continuada professor", "curso livre"],
  "blog-ensino-nacional": ["curso online", "ensino a distância", "capacitação empresa", "plataforma de cursos", "MEC cursos"],
  "tutor-esperto": ["cachorro", "gato", "pet", "veterinário", "ração"],
  "roda-sozinho": ["pequeno negócio site", "blog empresa", "SEO local", "Google meu negócio"],
  "vk-inspiracoes": ["vela aromática", "perfume artesanal", "sabonete artesanal", "decoração casa aromas"],
};
// blog EN fica de fora: o cron do servidor dele faz git pull e pega a pauta sozinho
const GITHUB = Object.fromEntries(Object.entries(PROJETOS_CASA).filter(([id]) => id !== "blog-ensino-nacional").map(([id, p]) => [id, p.repo]));

function hojeLocal() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function ehHoraDeRodar() {
  if (process.argv.includes("--agora") || SO_LER) return true;
  const t = new Date();
  if (t.getHours() * 60 + t.getMinutes() < HORA_MINIMA) return false;
  if (existsSync(MARCA_DIA) && readFileSync(MARCA_DIA, "utf8").trim() === hojeLocal()) return false;
  if (existsSync(PENDENTE) && Date.now() - Number(readFileSync(PENDENTE, "utf8").trim() || 0) < TENTAR_DE_NOVO_MS) return false;
  return true;
}
function marcarDia() { writeFileSync(MARCA_DIA, hojeLocal()); try { unlinkSync(PENDENTE); } catch {} }
function marcarPendente(motivo) { writeFileSync(PENDENTE, String(Date.now())); log(`rodada pendente (${motivo}); tento de novo em 2 h`); }

function lerToken() {
  if (process.env.METRICAS_TOKEN) return process.env.METRICAS_TOKEN;
  return execFileSync("security", ["find-generic-password", "-s", "Métricas - token de revisão", "-w"], { encoding: "utf8" }).trim();
}
let TOKEN = null;
async function api(caminho, corpo) {
  TOKEN ??= lerToken();
  const r = await fetch(SITE + caminho, { method: corpo ? "POST" : "GET", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : {}; } catch {}
  return { status: r.status, ok: r.ok, dados, texto };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function contextoComEspera() {
  for (let i = 0; i < 9; i++) {
    try { return await api("/api/radar"); } catch (e) { if (i === 8) throw e; log(`painel inacessível (${e?.cause?.code ?? e?.message ?? e}); tento de novo em 20 s`); await esperar(20_000); }
  }
}

// ---------- fontes ----------
function textoDe(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim());
}
async function lerFeed(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Metricas radar)" }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? await r.text() : "";
  } catch { return ""; }
}
async function tendencias() {
  const xml = await lerFeed("https://trends.google.com/trending/rss?geo=BR");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map((m) => ({
    termo: textoDe(m[1], "title")[0] ?? "",
    trafego: textoDe(m[1], "ht:approx_traffic")[0] ?? "",
    noticias: [...m[1].matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].slice(0, 2).map((n) => ({ titulo: textoDe(n[1], "ht:news_item_title")[0] ?? "", url: textoDe(n[1], "ht:news_item_url")[0] ?? "", fonte: textoDe(n[1], "ht:news_item_source")[0] ?? "" })),
  })).filter((t) => t.termo);
}
async function noticias(termo) {
  const xml = await lerFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(termo)}+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => ({ titulo: textoDe(m[1], "title")[0] ?? "", url: textoDe(m[1], "link")[0] ?? "", em: textoDe(m[1], "pubDate")[0] ?? "" })).filter((n) => n.titulo);
}

// ---------- Claude ----------
function montarPrompt(ctx, trends, news) {
  const j = (x) => JSON.stringify(x);
  return `Você é o RADAR diário do Métricas, o painel do Rammer. Ele tem blogs automáticos (um post por dia, fila de pautas em pautas.md) e quer TIMING: "conteúdo em alta, que vale artigo porque está viralizando ou saiu agora; tem que ser rápido; pesquisando e encontrando tudo de forma automática". Sua tarefa HOJE (${hojeLocal()}): para cada projeto, decidir se existe UMA pauta urgente que cabe no território dele e que vale publicar hoje por estar em alta. Ninguém lê sua resposta em tempo real: não faça perguntas.

PROJETOS (território em notas; consultas e páginas que já trazem clique no Google; posts recentes; pautas que o radar já enfileirou e o que renderam em 14 dias):
${j(ctx.projetos)}

GOOGLE TRENDS BRASIL HOJE (termos em alta, com tráfego aproximado e notícias):
${j(trends)}

GOOGLE NEWS DOS ÚLTIMOS 2 DIAS, POR TERMO DO TERRITÓRIO DE CADA PROJETO:
${j(news)}

Você está em ${CLIENTES} e pode LER (só ler) meus-clientes/<id>/ (CLAUDE.md = regras, território, proibições e clusters do projeto; pautas.md = fila e formato da tabela; src/content/posts = o que já existe). Leia o CLAUDE.md e o pautas.md de cada projeto antes de decidir. Não edite nada: quem escreve no pautas.md é o script que te chamou.

REGRAS
1. Pauta urgente só quando as três coisas são verdade: (a) está em alta HOJE ou nos últimos 2 dias (tendência, notícia, mudança de regra, data que se aproxima, evento) com prova (fonte_url); (b) cabe no território e nas proibições do CLAUDE.md do projeto (ex.: Guia não escreve how-to de criação de curso; blog EN não escreve novidades nem canibaliza o Guia; VK nunca cita marca de perfumaria; Tutor nunca promete resultado clínico); (c) tem busca real por trás (as pessoas vão procurar isso), de preferência uma cauda longa concreta.
2. 0 ou 1 pauta por projeto. Dia sem nada em alta que caiba = lista vazia e o resumo diz por quê. NÃO force: pauta que não está em alta é trabalho normal da fila, não do radar.
3. Não repita pauta já enfileirada pelo radar nem post recente (publicacoes_recentes, pautas_radar_recentes); aprenda com o que rendeu (impressoes_14/cliques_14/visitas_14).
4. A pauta vai para o pautas.md no formato do projeto: "pauta" é a busca-alvo em palavras (até 90 caracteres), cluster como o projeto usa (ou vazio), estagio tofu/mofu/bofu (ou vazio se o projeto não usa), trilha só na VK (nicho|produto).
5. Nada inventado: a pauta não pode exigir fato, número, preço, prazo ou prova social que o projeto não tem. Notícia de terceiros é contexto; o post do projeto responde à busca com o que o projeto sabe.
6. por_que: uma ou duas frases: o que está em alta e por que cabe aqui. Será lido pelo Rammer na aba do projeto.

RESPOSTA: só o JSON do esquema (resumo, pautas), em português, frases curtas.`;
}
function rodarClaude(prompt, cwd) {
  const args = ["-p", "--model", MODELO, "--output-format", "json", "--json-schema", ESQUEMA, "--no-session-persistence", "--permission-mode", "dontAsk", "--strict-mcp-config", "--allowedTools", ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)"].join(","), "--disallowedTools", ["Agent", "Edit", "Write", "NotebookEdit", "Workflow", "WebFetch"].join(",")];
  return rodarClaudeComContas(args, prompt, cwd, { tempoMaxMs: TEMPO_MAX_MS, log });
}
function extrairResultado(r) {
  try {
    const j = JSON.parse(r.saida);
    const so = j.structured_output ?? (typeof j.result === "string" ? JSON.parse(j.result) : j.result);
    if (so && Array.isArray(so.pautas)) return { so, custo: j.total_cost_usd ?? null };
  } catch {}
  return null;
}

// ---------- pautas.md ----------
function expandir(pasta) { return pasta.replace(/^~(?=\/|$)/, CASA); }
function git(pasta, args) { return execFileSync("git", args, { cwd: pasta, encoding: "utf8", timeout: 120_000 }); }

/** Insere a pauta no topo da tabela do pautas.md (depois da linha de separação do cabeçalho). Devolve o número dado. */
export function inserirPautaNoTopo(conteudo, p, hoje) {
  const linhas = conteudo.split("\n");
  const iCab = linhas.findIndex((l) => /^\|\s*#\s*\|/.test(l));
  if (iCab < 0 || !/^\|[\s:|-]+\|\s*$/.test(linhas[iCab + 1] ?? "")) throw new Error("tabela de pautas não encontrada");
  const colunas = linhas[iCab].split("|").slice(1, -1).map((c) => c.trim().toLowerCase());
  const numeros = linhas.slice(iCab + 2).map((l) => Number((l.match(/^\|\s*(\d+)\s*\|/) ?? [])[1])).filter((n) => Number.isFinite(n));
  const numero = (numeros.length ? Math.max(...numeros) : 0) + 1;
  const celula = (c) => {
    if (c === "#") return String(numero);
    if (c.startsWith("pauta")) return p.pauta;
    if (c === "cluster") return p.cluster || "geral";
    if (c.startsWith("est")) return p.estagio || "tofu";
    if (c === "trilha") return p.trilha || "nicho";
    if (c === "status") return `livre (urgente, radar ${hoje}: ${p.fonte})`;
    return "";
  };
  const linha = `| ${colunas.map(celula).join(" | ")} |`;
  linhas.splice(iCab + 2, 0, linha);
  return { conteudo: linhas.join("\n"), numero, linha };
}

/** Lê o status da pauta número N no pautas.md (para saber se virou post). */
export function statusDaPauta(conteudo, numero) {
  const l = conteudo.split("\n").find((x) => new RegExp(`^\\|\\s*${numero}\\s*\\|`).test(x));
  if (!l) return null;
  const cel = l.split("|").slice(1, -1).map((c) => c.trim());
  return cel[cel.length - 1] ?? null;
}

/** Onde fica a fila do projeto: raiz, site/ ou site/blog/ (Piloto Humano). */
function arquivoPautas(pasta) {
  return ["pautas.md", "site/pautas.md", "site/blog/pautas.md"].map((x) => join(pasta, x)).find((x) => existsSync(x)) ?? null;
}
async function enfileirar(projeto, p, hoje) {
  // na nuvem, por enquanto só os blogs da casa (no Mac os sites de cliente já ficavam de fora, sem pasta)
  if (NA_NUVEM && !PROJETOS_CASA[projeto.id]) return { ok: false, motivo: "radar só nos blogs da casa por enquanto" };
  const pasta = await pastaDoProjeto(projeto.id, projeto.pasta);
  const arq = pasta ? arquivoPautas(pasta) : null;
  if (!arq) return { ok: false, motivo: `sem pautas.md em ${projeto.pasta}` };
  const ramo = git(pasta, ["branch", "--show-current"]).trim();
  if (ramo !== "main") return { ok: false, motivo: `pasta no branch ${ramo}, não em main` };
  try { git(pasta, ["pull", "--ff-only", "-q", "origin", "main"]); } catch (e) { log(`${projeto.id}: git pull falhou (${String(e?.message ?? e).slice(0, 120)}); sigo com o que há`); }
  const antes = readFileSync(arq, "utf8");
  const { conteudo, numero, linha } = inserirPautaNoTopo(antes, p, hoje);
  writeFileSync(arq, conteudo);
  git(pasta, ["add", arq]);
  git(pasta, ["commit", "-q", "-m", `radar: pauta urgente ${numero} (${p.fonte}, ${hoje}): ${p.pauta}\n\n${p.por_que}\nFonte: ${p.fonte_url}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
  git(pasta, ["push", "-q", "origin", "main"]);
  log(`${projeto.id}: pauta ${numero} no topo do pautas.md, push feito: ${linha}`);
  // dispara o robô de posts (GitHub); blog EN e PH: o próprio cron deles faz git pull e pega a primeira livre
  if (GITHUB[projeto.id]) {
    try { ghNuvem(["workflow", "run", "robo-diario.yml", "-R", GITHUB[projeto.id]]); log(`${projeto.id}: robô de posts disparado no GitHub`); }
    catch (e) { log(`${projeto.id}: não consegui disparar o workflow (${String(e?.message ?? e).slice(0, 120)}); o cron do GitHub pega na próxima passagem`); }
  }

  return { ok: true, numero };
}

/** Confere as pautas enfileiradas em rodadas anteriores: virou post? (status "publicada (data) — slug"). */
async function conferirAnteriores(ctx) {
  const marcas = existsSync(join(AQUI, "radar-enfileiradas.json")) ? JSON.parse(readFileSync(join(AQUI, "radar-enfileiradas.json"), "utf8")) : [];
  const publicadas = [];
  const restantes = [];
  for (const m of marcas) {
    const projeto = ctx.projetos.find((p) => p.id === m.projeto);
    const pasta = projeto ? await pastaDoProjeto(projeto.id, projeto.pasta).catch(() => null) : null;
    const arq = pasta ? arquivoPautas(pasta) : null;
    if (!arq) { restantes.push(m); continue; }
    try { git(pasta, ["pull", "--ff-only", "-q", "origin", "main"]); } catch {}
    const st = statusDaPauta(readFileSync(arq, "utf8"), m.numero) ?? "";
    const slug = st.match(/publicada\s*\([^)]*\)\s*[—-]\s*`?([a-z0-9-]+)`?/i)?.[1];
    if (slug) publicadas.push({ id: m.id, post_url: `${projeto.endereco.replace(/\/+$/, "")}/${slug}`, nota: st.slice(0, 200) });
    else if (/descartada|transferida/i.test(st)) publicadas.push({ id: m.id, estado: "descartada", nota: st.slice(0, 200) });
    else if (Date.now() - m.em > 7 * 86400_000) publicadas.push({ id: m.id, estado: "descartada", nota: "7 dias sem virar post" });
    else restantes.push(m);
  }
  return { publicadas, restantes };
}

async function principal() {
  if (!ehHoraDeRodar()) return;
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 2 * 60 * 60 * 1000) { log("outra rodada em andamento (lock); saindo"); return; }
  writeFileSync(LOCK, String(process.pid));
  try {
    const r = await contextoComEspera();
    if (!r.ok) { log(`painel respondeu ${r.status}: ${r.texto.slice(0, 200)}`); marcarPendente("painel não respondeu"); return; }
    const ctx = r.dados;
    const hoje = hojeLocal();
    // na nuvem, clona antes os projetos que o Claude vai ler (CLAUDE.md e pautas.md de cada um)
    if (NA_NUVEM) for (const pr of ctx.projetos.filter((x) => PROJETOS_CASA[x.id])) await pastaDoProjeto(pr.id, null).catch((e) => log(`${pr.id}: sem clone (${String(e?.message ?? e).slice(0, 100)})`));
    const { publicadas, restantes } = await conferirAnteriores(ctx);
    if (publicadas.length) { const g = await api("/api/radar", { publicadas }); log(`pautas anteriores conferidas: ${publicadas.length} (painel ${g.ok ? "ok" : g.status})`); writeFileSync(join(AQUI, "radar-enfileiradas.json"), JSON.stringify(restantes)); }
    const trends = await tendencias();
    const news = {};
    for (const p of ctx.projetos) {
      news[p.id] = {};
      for (const t of TERMOS[p.id] ?? [p.nome]) news[p.id][t] = await noticias(t);
    }
    log(`${ctx.projetos.length} projeto(s); ${trends.length} tendência(s); notícias lidas para ${Object.keys(news).length} projeto(s)`);
    if (SO_LER) { console.log(JSON.stringify({ trends, news }, null, 1)); return; }
    const resultado = await rodarClaude(montarPrompt(ctx, trends, news), existsSync(CLIENTES) ? CLIENTES : AQUI);
    const falhou = async (motivo) => { try { await api("/api/radar", { estado: "falha", motivo, duracao_s: resultado.duracao, modelo: MODELO, pautas: [] }); } catch {} };
    if (resultado.tipo === "sem_cota_todas") { log(`nenhuma conta com cota (${resultado.mensagem})`); await falhou(`todas as contas sem cota (${resultado.mensagem})`); marcarPendente("sem cota"); return; }
    const res = extrairResultado(resultado);
    if (!res) { log(`claude não devolveu JSON (código ${resultado.codigo}, ${resultado.duracao}s):`, (resultado.erro || resultado.saida).slice(0, 400)); await falhou(`o Claude não devolveu o radar (código ${resultado.codigo})`); marcarPendente("sem JSON"); return; }
    log(`${resultado.duracao}s, custo ${res.custo ?? "?"}, conta ${resultado.conta}: ${res.so.resumo}`);
    const g = await api("/api/radar", { pautas: res.so.pautas, custo_usd: res.custo, duracao_s: resultado.duracao, modelo: MODELO });
    if (!g.ok) { log(`painel não aceitou (${g.status}): ${g.texto.slice(0, 200)}`); marcarPendente("painel não aceitou"); return; }
    for (const x of g.dados.recusadas ?? []) log(`  · recusada: ${x}`);
    // enfileira só as que o painel aceitou (as recusadas são repetidas): pega os ids das últimas criadas
    const aceitas = res.so.pautas.filter((p) => !(g.dados.recusadas ?? []).some((x) => x.startsWith(p.pauta)));
    const enf = existsSync(join(AQUI, "radar-enfileiradas.json")) ? JSON.parse(readFileSync(join(AQUI, "radar-enfileiradas.json"), "utf8")) : [];
    for (const p of aceitas) {
      const projeto = ctx.projetos.find((x) => x.id === p.projeto);
      if (!projeto) continue;
      const registro = (g.dados.ids ?? []).find((x) => x.projeto === p.projeto && x.pauta === p.pauta.replace(/\s+/g, " ").trim().slice(0, 300));
      try {
        const e = await enfileirar(projeto, p, hoje);
        if (e.ok) enf.push({ id: registro?.id ?? null, projeto: p.projeto, numero: e.numero, pauta: p.pauta, em: Date.now() });
        else { log(`${p.projeto}: não enfileirada (${e.motivo})`); if (registro?.id) await api("/api/radar", { publicadas: [{ id: registro.id, estado: "descartada", nota: `não entrou na fila: ${e.motivo}` }] }); }
      } catch (err) { log(`${p.projeto}: falhou ao enfileirar: ${String(err?.message ?? err).slice(0, 200)}`); if (registro?.id) await api("/api/radar", { publicadas: [{ id: registro.id, estado: "descartada", nota: `falhou ao enfileirar: ${String(err?.message ?? err).slice(0, 150)}` }] }); }
    }
    writeFileSync(join(AQUI, "radar-enfileiradas.json"), JSON.stringify(enf));
    marcarDia();
  } finally {
    try { unlinkSync(LOCK); } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on("unhandledRejection", (e) => { log("promessa rejeitada:", e?.stack ?? e); process.exit(1); });
  await principal();
}
