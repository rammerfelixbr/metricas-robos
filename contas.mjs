// Contas do Claude para os robôs do Métricas (06/10/2026; refeito em 13/10/2026).
// Regra do Rammer (13/10/2026): "os mesmos três tokens em todo lugar". conta1 e conta2 são as duas assinaturas
// Max e REVEZAM quem começa, dia sim, dia não; conta3 (a Pro) só entra se as duas Max estiverem sem cota. Os
// tokens vêm do Keychain do Mac ("Claude - token conta1/2/3", gravados só por ele, com `security add-generic-
// password`), nunca do chat nem de arquivo em pasta de projeto. Sem token no Keychain, vale o jeito antigo:
// as pastas de login do motor do Piloto Humano (`motor/contas.json` → `~/.claude-contas/<e-mail>`), que expiram
// sem aviso, e por último a sessão do CLI.
// Sem cota (429) ou credencial inválida (401) passa para a próxima; qualquer outro erro é erro de verdade.
// Modelo: quem chama passa `--model opus` (regra dele: "sem Sonnet em lugar nenhum").
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CASA = homedir();
const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === "darwin" ? `${CASA}/.local/node/bin/claude` : "claude");
const CONTAS_PH = join(CASA, "Documents/Clientes/meus-clientes/piloto-humano/motor/contas.json");
const PADRAO = []; // sem token, só as pastas de login listadas em motor/contas.json do Piloto Humano (no Mac)
// Deslocamento do revezamento neste robô (VK 0 · Guia 1 · Tutor 0 · Roda 1 · blog EN 0 · PH 1 · Métricas 0).
const DESLOCAMENTO = Number(process.env.METRICAS_DESLOCAMENTO ?? 0);

// No GitHub Actions (06/11/2026) os mesmos três tokens chegam como secrets, com os nomes que os robôs de posts já usam
// nos repositórios: CLAUDE_CODE_OAUTH_TOKEN, _2, _3 = conta1, conta2, conta3. Fora do Actions o ambiente é ignorado:
// no Mac quem manda é o Keychain, e um token solto no ambiente nunca escolhe a conta.
function tokenDoKeychain(n) {
  if (process.env.GITHUB_ACTIONS === "true") return (process.env[n === 1 ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${n}`] ?? "").trim() || null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", `Claude - token conta${n}`, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function diaDoAno(d = new Date()) {
  const inicio = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - inicio) / 86400000);
}

/** Lista as contas disponíveis neste Mac, na ordem de uso de hoje; a sessão do CLI fecha a lista. */
export function listarContas() {
  const contas = [];
  const t1 = tokenDoKeychain(1);
  const t2 = tokenDoKeychain(2);
  const t3 = tokenDoKeychain(3);
  if (t1 || t2) {
    const ordem = (diaDoAno() + DESLOCAMENTO) % 2 === 0 ? ["conta1", "conta2"] : ["conta2", "conta1"];
    for (const c of ordem) {
      if (c === "conta1" && t1) contas.push({ rotulo: "conta1", token: t1, dir: null });
      if (c === "conta2" && t2) contas.push({ rotulo: "conta2", token: t2, dir: null });
    }
    if (t3) contas.push({ rotulo: "conta3", token: t3, dir: null });
  } else {
    let emails = PADRAO;
    try {
      const j = JSON.parse(readFileSync(CONTAS_PH, "utf8"));
      if (Array.isArray(j) && j.length) emails = j.map((c) => c.email ?? c);
    } catch {}
    for (const e of emails) {
      const dir = join(CASA, ".claude-contas", e);
      if (existsSync(dir)) contas.push({ rotulo: e, token: null, dir });
    }
  }
  contas.push({ rotulo: "sessão do CLI", token: null, dir: null });
  return contas;
}

/** Lê a saída do `claude -p --output-format json` e diz se foi cota, credencial, erro ou ok. */
export function classificar({ codigo, saida, erro }) {
  let j = null;
  try { j = JSON.parse(saida); } catch {}
  const texto = `${j?.result ?? ""}\n${erro ?? ""}\n${j ? "" : saida ?? ""}`;
  const status = j?.api_error_status ?? null;
  if (status === 429 || /weekly limit|usage limit|rate limit|hit your .* limit|limit · resets/i.test(texto)) {
    const linha = (j?.result ?? texto).trim().split("\n").find((l) => /limit/i.test(l)) ?? "sem cota";
    const volta = linha.match(/resets? [A-Za-z0-9 ,:()/]*/)?.[0] ?? null;
    return { tipo: "sem_cota", mensagem: volta ? `sem cota (${volta})` : linha.slice(0, 120) };
  }
  if (status === 401 || /OAuth access token is invalid|OAuth session expired|Failed to authenticate|Not logged in|Invalid authentication/i.test(texto)) {
    return { tipo: "sem_credencial", mensagem: "token inválido ou expirado" };
  }
  // 28/10/2026: a organização da conta2 desligou o acesso ao Claude Code pela assinatura. É erro DA conta (só o Rammer
  // religa no admin), não do prompt: passa para a próxima conta em vez de parar a rodada.
  if (/disabled Claude subscription access/i.test(texto)) {
    return { tipo: "sem_credencial", mensagem: "acesso ao Claude Code desligado na organização desta conta (religar no admin do claude.ai)" };
  }
  if (j && !j.is_error) return { tipo: "ok", mensagem: "" };
  return { tipo: "erro", mensagem: (texto.trim() || `código ${codigo}`).slice(0, 300) };
}

function rodarUmaVez(args, prompt, cwd, conta, tempoMaxMs, log) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    let saida = "";
    let erro = "";
    let fechou = false;
    let filho;
    let timerKill = null;
    const terminar = (codigo, extra = "") => {
      if (fechou) return;
      fechou = true;
      clearTimeout(timer);
      clearTimeout(timerKill);
      resolve({ codigo, saida, erro: erro + extra, duracao: Math.round((Date.now() - inicio) / 1000) });
    };
    // Mata o GRUPO de processos (caffeinate + claude + filhos): em 12/10/2026 um claude preso por permissão não trancada
    // ficou 5 h rodando porque o kill só atingia o processo pai.
    const matar = (sinal) => { try { process.kill(-filho.pid, sinal); } catch { try { filho?.kill(sinal); } catch {} } };
    const timer = setTimeout(() => {
      log("tempo esgotado; matando o claude");
      matar("SIGTERM");
      timerKill = setTimeout(() => matar("SIGKILL"), 10000);
    }, tempoMaxMs);
    const env = { ...process.env, HOME: CASA };
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // o robô decide a conta; nunca um token solto do ambiente
    delete env.CLAUDE_CONFIG_DIR;
    if (conta.token) env.CLAUDE_CODE_OAUTH_TOKEN = conta.token;
    else if (conta.dir) env.CLAUDE_CONFIG_DIR = conta.dir;
    try {
      // caffeinate -i (13/10/2026): o Mac dorme com 1 min ocioso; segura o sono enquanto o claude roda.
      filho = process.platform === "darwin" ? spawn("/usr/bin/caffeinate", ["-i", CLAUDE, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true }) : spawn(CLAUDE, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      return terminar(null, `não consegui iniciar o claude: ${e.message}`);
    }
    filho.on("error", (e) => terminar(null, `erro ao rodar o claude: ${e.message}`));
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (erro += d));
    filho.on("close", (codigo) => terminar(codigo));
    filho.stdin.on("error", () => {});
    filho.stdin.end(prompt);
  });
}

let indice = 0; // a conta que funcionou por último fica como primeira tentativa da próxima chamada (dentro da rodada)

/**
 * Roda `claude -p` tentando as contas em ordem. Devolve a saída da primeira que respondeu de verdade, com
 * `conta` (rótulo) e `tipo` ("sem_cota_todas" quando nenhuma serviu, com `mensagem` dizendo cada uma).
 */
export async function rodarClaudeComContas(args, prompt, cwd, { tempoMaxMs, log }) {
  const contas = listarContas();
  const tentativas = [];
  for (let n = 0; n < contas.length; n++) {
    const conta = contas[(indice + n) % contas.length];
    const r = await rodarUmaVez(args, prompt, cwd, conta, tempoMaxMs, log);
    const c = classificar(r);
    if (c.tipo === "sem_cota" || c.tipo === "sem_credencial") {
      log(`  conta ${conta.rotulo}: ${c.mensagem}; tento a próxima`);
      tentativas.push(`${conta.rotulo}: ${c.mensagem}`);
      continue;
    }
    indice = (indice + n) % contas.length;
    return { ...r, conta: conta.rotulo, tipo: c.tipo, mensagem: c.mensagem };
  }
  return { codigo: null, saida: "", erro: "", duracao: 0, conta: null, tipo: "sem_cota_todas", mensagem: tentativas.join("; "), tentativas };
}

/**
 * Conferência diária das contas (13/10/2026): uma pergunta mínima em cada conta com token, para o painel dizer de
 * manhã "conta1 ok · conta2 sem cota (volta 15/10) · conta3 ok" antes de qualquer robô precisar. Custa centavos.
 * Devolve { estado: "ok" | "falha", motivo, custo } no formato do POST /api/rodada (robo "contas").
 */
export async function conferirContas({ log, modelo = "opus" }) {
  const contas = listarContas().filter((c) => c.token);
  if (!contas.length) return { estado: "falha", motivo: process.env.GITHUB_ACTIONS === "true" ? "nenhum token do Claude nos secrets do repositório (CLAUDE_CODE_OAUTH_TOKEN, _2, _3)" : "nenhum token no Keychain (Claude - token conta1/2/3); os robôs dependem de login de sessão, que expira", custo: 0 };
  const args = ["-p", "--model", modelo, "--output-format", "json", "--no-session-persistence", "--max-turns", "1", "--strict-mcp-config", "--disallowedTools", "Agent,Bash,Edit,Write,WebFetch,WebSearch"];
  const partes = [];
  let custo = 0;
  let falhou = false;
  for (const conta of contas.sort((a, b) => a.rotulo.localeCompare(b.rotulo))) {
    const r = await rodarUmaVez(args, "Responda apenas: ok", process.cwd(), conta, 120_000, log);
    const c = classificar(r);
    try { custo += JSON.parse(r.saida)?.total_cost_usd ?? 0; } catch {}
    if (c.tipo === "ok") partes.push(`${conta.rotulo}: ok`);
    else { falhou = true; partes.push(`${conta.rotulo}: ${c.mensagem}`); }
    log(`  ${partes[partes.length - 1]}`);
  }
  return { estado: falhou ? "falha" : "ok", motivo: partes.join(" · "), custo: Math.round(custo * 10000) / 10000 };
}
