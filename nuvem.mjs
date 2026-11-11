// O que muda quando um robô do Métricas roda no GitHub Actions em vez do Mac (06/11/2026; docs/06).
// Regra do Rammer: nada do Roda Sozinho pode depender do Mac ligado. Cada robô continua um arquivo só e
// decide pelo `NA_NUVEM`: token por variável de ambiente (secret) em vez do Keychain, pastas dos projetos
// clonadas do GitHub em vez das pastas do Mac, e o painel como memória ("já rodei hoje?") em vez de arquivo no disco.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NA_NUVEM = process.env.GITHUB_ACTIONS === "true";
export const CASA = homedir();
export const SITE = process.env.METRICAS_URL ?? "https://metricas.rammerfelix.workers.dev";
export const RODA = process.env.RODA_URL ?? "https://painel.rodasozinho.com.br";
/** Onde os projetos são clonados na nuvem (`meus-clientes/<id>`, o mesmo desenho das pastas do Mac). */
export const TRABALHO = process.env.TRABALHO_DIR ?? (NA_NUVEM ? join(process.env.GITHUB_WORKSPACE ?? process.cwd(), "trabalho") : join(CASA, "Documents/Clientes"));
export const GH = process.env.GH_BIN ?? (process.platform === "darwin" ? "/opt/homebrew/bin/gh" : "gh");

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Token do Métricas: variável de ambiente (secret no GitHub) ou, no Mac, o Keychain. */
export function lerToken() {
  if (process.env.METRICAS_TOKEN) return process.env.METRICAS_TOKEN;
  if (NA_NUVEM) throw new Error("METRICAS_TOKEN não está no ambiente (secret do repositório)");
  return execFileSync("security", ["find-generic-password", "-s", "Métricas - token de revisão", "-w"], { encoding: "utf8" }).trim();
}

let TOKEN = null;
export async function api(caminho, corpo, base = SITE) {
  TOKEN ??= lerToken();
  const r = await fetch(base + caminho, { method: corpo ? "POST" : "GET", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : {}; } catch {}
  return { status: r.status, ok: r.ok, dados, texto };
}

/** Chama o painel esperando a rede (no Mac, logo depois do login, a rede demora alguns segundos). */
export async function apiComEspera(caminho) {
  for (let i = 0; i < 9; i++) {
    try { return await api(caminho); } catch (e) { if (i === 8) throw e; log(`painel inacessível (${e?.cause?.code ?? e?.message ?? e}); tento de novo em 20 s`); await esperar(20_000); }
  }
}

/** Hoje, no fuso de Brasília (os robôs raciocinam no dia do Rammer; no Actions o TZ do processo é America/Sao_Paulo). */
export function hojeLocal(t = new Date()) {
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/** A última rodada deste robô segundo o painel (GET /api/rodada?robo=): `{ ultima, ultima_ok }`, cada um `{ em, estado, motivo }` ou null. */
export async function ultimaRodada(robo) {
  const r = await api(`/api/rodada?robo=${encodeURIComponent(robo)}`);
  if (!r.ok) throw new Error(`painel respondeu ${r.status} ao perguntar a última rodada de ${robo}`);
  return r.dados;
}

// Projetos da casa que têm repositório no GitHub e publicam quando `main` muda. "publicacao" diz ao robô de revisão
// como o site vai ao ar depois do push: "push" = a hospedagem publica sozinha (Vercel/Pages); "servidor" = o servidor
// do projeto faz git pull e publica na próxima rodada do robô de posts dele (blog EN). O Piloto Humano fica fora: o
// Worker dele só é publicado do Mac (`npm run deploy`); entra quando sair do Mac.
export const PROJETOS_CASA = {
  "vk-inspiracoes": { repo: "rammerfelixbr/vk-inspiracoes", publicacao: "push" },
  "guia-do-certificado": { repo: "rammerfelixbr/guia-do-certificado", publicacao: "push" },
  "tutor-esperto": { repo: "rammerfelixbr/tutor-esperto", publicacao: "push" },
  "roda-sozinho": { repo: "rammerfelixbr/rodasozinho", publicacao: "push" },
  "blog-ensino-nacional": { repo: "rammerfelixbr/blog-ensino-nacional", publicacao: "servidor" },
};

/** Sites com robô no GitHub segundo o painel do Roda (clientes e casa): `[{ id, nome, repo, workflow, posts_semana, site, cliente }]`. */
export async function sitesDoRoda() {
  const r = await api("/api/sites-robo", undefined, RODA);
  if (!r.ok) throw new Error(`painel do Roda respondeu ${r.status} em /api/sites-robo`);
  return r.dados.sites ?? [];
}

let mapa = null;
/** id do projeto → { repo, publicacao, workflow }, juntando a casa e os clientes do Roda. */
export async function mapaDeProjetos() {
  if (mapa) return mapa;
  mapa = Object.fromEntries(Object.entries(PROJETOS_CASA).map(([id, p]) => [id, { ...p, workflow: "robo-diario.yml" }]));
  try {
    for (const s of await sitesDoRoda()) mapa[s.id] ??= { repo: s.repo, publicacao: "push", workflow: s.workflow };
  } catch (e) {
    log(`não consegui ler os sites do Roda (${e?.message ?? e}); sigo só com os da casa`);
  }
  return mapa;
}

function tokenDoGitHub() {
  const t = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GH_TOKEN não está no ambiente (secret ROBOS_GITHUB_TOKEN)");
  return t;
}

export function git(pasta, args, opcoes = {}) {
  return execFileSync("git", args, { cwd: pasta, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], ...opcoes });
}

/**
 * A pasta do projeto onde o robô trabalha. No Mac é a pasta cadastrada no painel; na nuvem é um clone fresco de
 * `main` em `trabalho/meus-clientes/<id>` (uma vez por rodada), com identidade de commit do robô. Devolve null quando
 * o projeto não tem repositório conhecido (ou a pasta do Mac não existe).
 */
export async function pastaDoProjeto(id, pastaNoMac) {
  if (!NA_NUVEM) {
    const pasta = (pastaNoMac ?? "").replace(/^~(?=\/|$)/, CASA);
    return pasta && existsSync(pasta) ? pasta : null;
  }
  const p = (await mapaDeProjetos())[id];
  if (!p) return null;
  const destino = join(TRABALHO, "meus-clientes", id);
  if (existsSync(join(destino, ".git"))) return destino;
  mkdirSync(join(TRABALHO, "meus-clientes"), { recursive: true });
  const url = `https://x-access-token:${tokenDoGitHub()}@github.com/${p.repo}.git`;
  execFileSync("git", ["clone", "--quiet", "--depth", "50", "--branch", "main", url, destino], { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
  git(destino, ["config", "user.name", "Métricas"]);
  git(destino, ["config", "user.email", "metricas@rodasozinho.com.br"]);
  return destino;
}

/** Instala as dependências do projeto clonado (o build precisa delas); silencioso quando não há package-lock. */
export function instalarDependencias(pasta) {
  if (!existsSync(join(pasta, "package-lock.json"))) return;
  execFileSync("npm", ["ci", "--no-fund", "--no-audit", "--silent"], { cwd: pasta, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** `gh` com o token do robô (na nuvem) ou a sessão do Mac. */
export function gh(args) {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
  if (NA_NUVEM) env.GH_TOKEN = tokenDoGitHub();
  return execFileSync(GH, args, { encoding: "utf8", timeout: 60_000, env });
}
