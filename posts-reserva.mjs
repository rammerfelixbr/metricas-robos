#!/usr/bin/env node
// Reserva dos robôs de posts que rodam no GitHub Actions (VK, Guia, Tutor, Roda). Métricas, 15/10/2026.
//
// Por quê: o cron do GitHub é "melhor esforço": em 14/10/2026 só 3 das 6 passagens marcadas dispararam, e em 15/10 a
// das 10h07 não tinha disparado às 11h30. As contas do Claude tinham cota; o que faltou foi o GitHub chamar o robô.
// Regra do Rammer: "todos os projetos têm que ser publicados todos os dias".
//
// O que faz: o launchd chama este arquivo a cada 5 min (e no login). A partir das 11h (hora do Mac, Brasília), para
// cada projeto do GitHub sem commit "post:" hoje, dispara o workflow `robo-diario.yml` pelo `gh` (já logado neste
// Mac, conta rammerfelixbr), no máximo 1 vez a cada 2 h e 4 vezes por dia, e só se não houver rodada em andamento.
// O robô disparado decide sozinho se publica (guarda de cadência no gerar-post.sh de cada repositório).
// Marca por projeto em robo/reserva-<id>.txt ("AAAA-MM-DD <disparos> <último ts>"). Cada disparo é informado ao
// painel (`POST /api/rodada`, robô `posts-reserva:<id>`, custo zero). `--testar` só relata, não dispara.
// Log: ~/Library/Logs/metricas-posts-reserva.log. Na mão: `node robo/posts-reserva.mjs [--testar]`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.METRICAS_URL ?? "https://metricas.rammerfelix.workers.dev";
const GH = process.env.GH_BIN ?? "/opt/homebrew/bin/gh";
const TESTAR = process.argv.includes("--testar");
const HORA_MINIMA = 11 * 60; // 1ª passagem do cron do GitHub é 10h07 (Brasília); às 11h já está 50 min atrasada
const INTERVALO_MS = 2 * 60 * 60 * 1000;
const MAX_POR_DIA = 4;
const WORKFLOW = "robo-diario.yml";
const PROJETOS = [
  { id: "vk-inspiracoes", repo: "rammerfelixbr/vk-inspiracoes" },
  { id: "guia-do-certificado", repo: "rammerfelixbr/guia-do-certificado" },
  { id: "tutor-esperto", repo: "rammerfelixbr/tutor-esperto" },
  { id: "roda-sozinho", repo: "rammerfelixbr/rodasozinho" },
];
const log = (...a) => console.log(new Date().toISOString(), ...a);

const agora = new Date();
const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
const minutos = agora.getHours() * 60 + agora.getMinutes();
if (minutos < HORA_MINIMA && !TESTAR) process.exit(0); // antes das 11h: silêncio (o launchd chama de 5 em 5 min)

function gh(args) {
  return execFileSync(GH, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: process.env.HOME, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
}
function lerMarca(id) {
  const f = join(AQUI, `reserva-${id}.txt`);
  if (!existsSync(f)) return { dia: "", disparos: 0, ultimo: 0 };
  const [dia, disparos, ultimo] = readFileSync(f, "utf8").trim().split(/\s+/);
  return dia === hoje ? { dia, disparos: Number(disparos) || 0, ultimo: Number(ultimo) || 0 } : { dia: "", disparos: 0, ultimo: 0 };
}
function gravarMarca(id, m) {
  writeFileSync(join(AQUI, `reserva-${id}.txt`), `${hoje} ${m.disparos} ${m.ultimo}\n`);
}
/** Houve commit "post:" em main hoje (dia de Brasília)? */
function postHoje(repo) {
  const meiaNoite = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString();
  const saida = gh(["api", `repos/${repo}/commits?sha=main&since=${meiaNoite}&per_page=30`, "--jq", ".[].commit.message | split(\"\\n\")[0]"]);
  return saida.split("\n").filter((l) => /^post:/.test(l));
}
function rodadaEmAndamento(repo) {
  const saida = gh(["run", "list", "-R", repo, "--workflow", WORKFLOW, "--limit", "5", "--json", "status", "--jq", ".[].status"]);
  return saida.split("\n").some((s) => s === "in_progress" || s === "queued" || s === "waiting" || s === "requested");
}
async function informarPainel(id, motivo) {
  let token = process.env.METRICAS_TOKEN;
  try {
    token ||= execFileSync("security", ["find-generic-password", "-s", "Métricas - token de revisão", "-w"], { encoding: "utf8" }).trim();
  } catch {}
  if (!token) return;
  try {
    await fetch(`${SITE}/api/rodada`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ robo: `posts-reserva:${id}`, projeto_id: id, estado: "ok", motivo, duracao_s: 1, custo_usd: 0 }),
    });
  } catch (e) {
    log(`  ⚠ não consegui informar o painel: ${e?.message ?? e}`);
  }
}

let algo = false;
for (const p of PROJETOS) {
  try {
    const posts = postHoje(p.repo);
    if (posts.length > 0) continue; // em dia: nada a fazer, nada a logar
    algo = true;
    const marca = lerMarca(p.id);
    const hhmm = `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`;
    if (marca.disparos >= MAX_POR_DIA) { log(`${p.id}: sem post hoje e já disparei ${marca.disparos}× (teto ${MAX_POR_DIA}); fica para o Rammer`); continue; }
    if (Date.now() - marca.ultimo < INTERVALO_MS) { log(`${p.id}: sem post hoje; disparo de reserva há menos de 2 h, esperando`); continue; }
    if (rodadaEmAndamento(p.repo)) { log(`${p.id}: sem post hoje, mas há rodada em andamento no GitHub; esperando`); continue; }
    if (TESTAR) { log(`${p.id}: sem post hoje às ${hhmm}; dispararia ${WORKFLOW} em ${p.repo} (teste, não disparei)`); continue; }
    gh(["workflow", "run", WORKFLOW, "-R", p.repo]);
    marca.disparos += 1;
    marca.ultimo = Date.now();
    gravarMarca(p.id, marca);
    const motivo = `cron do GitHub não rodou até ${hhmm}: disparo de reserva ${marca.disparos}/${MAX_POR_DIA} pelo Mac`;
    log(`${p.id}: ${motivo}`);
    await informarPainel(p.id, motivo);
  } catch (e) {
    algo = true;
    log(`${p.id}: erro na reserva: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`);
  }
}
if (TESTAR && !algo) log("os 4 projetos do GitHub têm post hoje; nada a disparar");
