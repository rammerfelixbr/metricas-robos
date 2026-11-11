#!/usr/bin/env node
// Fila do IndexNow (Métricas, 15/10/2026; docs/22): o Bing devolve 429 ao IP compartilhado da Cloudflare, então o
// Worker guarda as URLs que não entraram e este script, no Mac (launchd a cada 30 min), manda de cá e baixa a fila.
// Token: Keychain "Métricas - token de revisão". Log: ~/Library/Logs/metricas-indexnow.log. Na mão: `node robo/indexnow.mjs`.
import { execFileSync } from "node:child_process";
const SITE = process.env.METRICAS_URL ?? "https://metricas.rammerfelix.workers.dev";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const TOKEN = process.env.METRICAS_TOKEN ?? execFileSync("security", ["find-generic-password", "-s", "Métricas - token de revisão", "-w"], { encoding: "utf8" }).trim();
async function api(caminho, corpo) {
  const r = await fetch(SITE + caminho, { method: corpo ? "POST" : "GET", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { ok: r.ok, status: r.status, dados: await r.json().catch(() => null) };
}
const r = await api("/api/indexnow/fila");
if (!r.ok) { log(`painel respondeu ${r.status}`); process.exit(1); }
for (const f of r.dados.fila ?? []) {
  const resp = await fetch("https://www.bing.com/indexnow", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ host: f.host, key: f.chave, keyLocation: f.keyLocation, urlList: f.urls.slice(0, 10000) }) });
  const ok = resp.status === 200 || resp.status === 202;
  log(`${f.projeto}: ${f.urls.length} url(s) → Bing ${resp.status}${ok ? "" : " (fica na fila)"}`);
  if (ok) { const b = await api("/api/indexnow/fila", { projeto: f.projeto, enviadas: f.urls, status: resp.status }); log(`  fila baixada: ${b.dados?.baixadas ?? "?"}`); }
  await new Promise((x) => setTimeout(x, 2000));
}
