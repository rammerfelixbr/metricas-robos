#!/usr/bin/env node
// Revisão automática diária do Métricas (pedido do Rammer em 03/10/2026: "identificação e correção automáticas").
// Roda no Mac (launchd, 07:30): lê em https://metricas.rammerfelix.workers.dev/api/pendencias o que cada projeto tem
// de errado (links quebrados, SEO das páginas, site fora, sem post), abre o Claude Code (`claude -p`, pela assinatura)
// NA PASTA DO PROJETO para corrigir o que é seguro corrigir e publicar pelo fluxo daquele projeto, e devolve ao
// painel o que fez (vira "decisão registrada" no projeto) e o que ficou para o Rammer (aparece na grade).
//
// Token: item "Métricas - token de revisão" no Keychain (ou METRICAS_TOKEN no ambiente); o mesmo valor é o
// REVISAO_TOKEN do Worker. Log: ~/Library/Logs/metricas-revisao.log. Na mão: `node robo/revisar.mjs [projeto-id]`.
//
// Desde 06/11/2026 roda no GitHub Actions (`.github/workflows/revisao.yml`, 07:30 de Brasília e mais três passagens
// de retentativa): lá cada projeto é clonado de `main` (nuvem.mjs), o Claude corrige e dá push, e a hospedagem publica.
// O Piloto Humano fica fora na nuvem (o Worker dele só é publicado do Mac). O painel é a memória: projeto revisado há
// menos de 12 h sem erro não é refeito, então as passagens extras só pegam o que falhou.
import { conferirContas, rodarClaudeComContas } from "./contas.mjs";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NA_NUVEM, api, apiComEspera, esperar, instalarDependencias, log, mapaDeProjetos, pastaDoProjeto } from "./nuvem.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MODELO = process.env.METRICAS_MODELO ?? "opus"; // Rammer, 02/10/2026: nada em Sonnet
const TEMPO_MAX_MS = 20 * 60 * 1000; // por projeto
const LOCK = join(AQUI, "lock");
const ESQUEMA = readFileSync(join(AQUI, "esquema.json"), "utf8");
const SO = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null; // rodar só um projeto (teste na mão)

// Gatilho robusto (04/10/2026): o launchd roda este arquivo a cada 30 min (StartInterval) e ELE decide se é hora.
// Motivo: em 04/10 o StartCalendarInterval das 07:30 simplesmente não disparou (runs = 0 com o Mac acordado).
// Regra: roda uma vez por dia, na primeira passagem a partir das 07:30 (hora do Mac). `--agora` ou um projeto
// como argumento ignora a janela (teste na mão / kickstart).
const MARCA_DIA = join(AQUI, "ultima-rodada.txt");
// Hora da rodada: robo/hora.txt ("HH:MM"); sem o arquivo, 07:30. Serve para o Rammer testar mudando só o arquivo.
function horaMinima() {
  try {
    const m = readFileSync(join(AQUI, "hora.txt"), "utf8").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  } catch {}
  return 7 * 60 + 30;
}
function ehHoraDeRodar() {
  if (SO || process.argv.includes("--agora") || NA_NUVEM) return true; // na nuvem quem marca a hora é o cron do workflow
  const agoraLocal = new Date();
  const hoje = `${agoraLocal.getFullYear()}-${String(agoraLocal.getMonth() + 1).padStart(2, "0")}-${String(agoraLocal.getDate()).padStart(2, "0")}`;
  const minutos = agoraLocal.getHours() * 60 + agoraLocal.getMinutes();
  if (minutos < horaMinima()) return false;
  if (existsSync(MARCA_DIA) && readFileSync(MARCA_DIA, "utf8").trim() === hoje) return false;
  if (existsSync(PENDENTE) && Date.now() - Number(readFileSync(PENDENTE, "utf8").trim() || 0) < TENTAR_DE_NOVO_MS) return false; // falhou há pouco: espera 2 h
  return true; // a marca do dia é gravada no fim, só se a rodada não falhou por cota/erro em tudo (marcarDia)
}
// Regra do Rammer (13/10/2026): "se ficou sem cota, tem que tentar de novo depois". Rodada em que o Claude falhou em
// todos os projetos com trabalho (sem cota, token, erro) NÃO marca o dia: fica pendente e a passagem de 5 min tenta de
// novo 2 h depois, até dar certo no dia. Projeto que deu certo não é refeito (o painel guarda a revisão sem erro).
const PENDENTE = join(AQUI, "revisao-pendente.txt");
const TENTAR_DE_NOVO_MS = 2 * 60 * 60 * 1000;
function marcarPendente(motivo) {
  if (NA_NUVEM) { log(`rodada incompleta (${motivo}); a próxima passagem do workflow tenta de novo`); return; }
  writeFileSync(PENDENTE, String(Date.now()));
  log(`rodada pendente (${motivo}); tento de novo em 2 h`);
}
function marcarDia() {
  if (NA_NUVEM) return; // o painel guarda a revisão de cada projeto; não há disco entre uma passagem e outra
  try { unlinkSync(PENDENTE); } catch {}
  const t = new Date();
  writeFileSync(MARCA_DIA, `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`);
}
/** No login o Mac ainda está sem rede por alguns segundos (teste 2 de 04/10/2026: ENOTFOUND). Tenta por até 3 min. */
const pendenciasComEspera = () => apiComEspera("/api/pendencias");

/** O projeto tem algo que o robô pode tentar corrigir? */
function temTrabalho(p) {
  return p.links_quebrados.length > 0 || p.seo.piores_paginas.length > 0 || (p.acoes ?? []).length > 0 || (p.titulos?.aplicar ?? []).length > 0 || (p.titulos?.reverter ?? []).length > 0;
}

function montarPrompt(p, publicacao) {
  const j = (x) => JSON.stringify(x, null, 1);
  const naNuvem = !publicacao
    ? ""
    : `
ONDE VOCÊ ESTÁ: numa máquina do GitHub Actions, num clone fresco de \`main\` deste repositório, já em \`main\` e com as dependências instaladas. Publicar aqui é só \`git add\` dos arquivos que você editou, \`git commit\` e \`git push origin main\`${publicacao === "servidor" ? " (o servidor deste projeto faz git pull e publica o site na próxima rodada do robô de posts dele; não tente ssh nem deploy.sh)" : " (a hospedagem publica o site sozinha quando main muda)"}. Não existe ssh, Keychain, wrangler nem \`npm run deploy\` nesta máquina: se o CLAUDE.md mandar publicar de outro jeito, ignore essa parte e faça o push. Se o push for rejeitado, \`git pull --rebase origin main\` e tente de novo uma vez.
`;
  return `Você é a revisão automática diária do Métricas (o painel do Rammer). Está na pasta do projeto "${p.nome}" (${p.endereco}), hospedagem: ${p.hospedagem ?? "?"}. Corrija o que é seguro corrigir, publique pelo fluxo deste projeto e devolva o JSON pedido. Ninguém vai ler sua resposta em tempo real: não faça perguntas; o que precisar de decisão humana vai em "para_o_rammer".
${naNuvem}
ANTES DE TUDO: leia o CLAUDE.md desta pasta (e STATUS.md/INSTRUCOES.md se existirem). As regras dele valem acima destas: fatos permitidos, proibições, como publicar, onde registrar. Confira \`git status\` e \`git branch --show-current\`: produção é o branch \`main\`. Se não estiver em \`main\`, mude (\`git checkout main && git pull --ff-only\`); se não der, relate em "para_o_rammer" e pare. Mudanças sem commit que já existiam em arquivos que você NÃO vai mexer (STATUS.md, docs/, anotações de outra sessão) não impedem o trabalho: deixe-as como estão, faça \`git add\` só dos arquivos que você editou e cite-as em "para_o_rammer". Só pare se a sujeira estiver em arquivo que você precisaria editar.

O QUE O PAINEL ACHOU NESTE PROJETO
Resumo: ${j(p.resumo)}
Links quebrados em aberto (pagina = onde está o link; url = o que falhou; status null = não respondeu): ${j(p.links_quebrados)}
SEO das páginas amostradas (nota 0-100; titulo_tam ideal 20-65; descricao_tam 0 = sem meta description, ideal 70-160; h1 ideal 1; imagens_sem_alt; palavras < 300 = curta; canonical 0 = sem): ${j(p.seo)}
Implementações de SEO (por página: og/og_img/og_desc/twitter/jsonld/lang/viewport/favicon; no site: robots.txt com Sitemap, llms.txt, feed). "faltas.mecanicas" você corrige no layout; "faltas.decisao" só relata: ${j(p.implementacoes)}
Carregamento no celular (PageSpeed; LCP em ms; "lento" = acima da meta de 2,5 s do Google): ${j(p.carregamento)}
Programas de afiliado (o "padrao" é o trecho que identifica o link certo): ${j(p.programas)}
${p.fora_do_ar ? `Site fora do ar: ${j(p.fora_do_ar)}\n` : ""}${p.sem_post ? `Publicações atrasadas: ${j(p.sem_post)}\n` : ""}${p.feed_erro ? `Erro ao ler o feed: ${p.feed_erro}\n` : ""}${p.ultima_revisao ? `Última revisão automática: ${j(p.ultima_revisao)} (não repita o que já foi relatado para o Rammer se nada mudou)\n` : ""}
${
  (p.acoes ?? []).length
    ? `AÇÕES DE INTELIGÊNCIA APROVADAS PARA ESTE PROJETO (aprendidas em outro projeto do Rammer; as "estrategica" já têm o "sim" dele, as "mecanica" são da sua alçada):
${j(p.acoes)}
Para cada ação: aplique exatamente o que "acao" descreve, respeitando o CLAUDE.md deste projeto (se a ação contrariar uma regra do projeto, resultado "nao_deu" e diga qual regra). Ação estratégica pode mudar estrutura/linha editorial do que a ação descreve, mas continua valendo: nenhum fato, preço, promessa ou prova social inventados; ficha do cliente é a única fonte. Se a ação pede conteúdo novo (ex.: tipo de post), ajuste a REGRA/MODELO que o robô de posts deste projeto usa (prompt, template, calendário), não escreva o post você mesmo. Devolva uma entrada em "acoes" por ação, com o mesmo id.
`
    : ""
}${
  (p.titulos?.aplicar ?? []).length || (p.titulos?.reverter ?? []).length
    ? `CICLO DE TÍTULOS (docs/20 do Métricas; teste sequencial medido pelo Search Console em 21 dias):
Aplicar (trocar title e meta description da página pela variante; o painel mede 21 dias depois): ${j(p.titulos.aplicar)}
Reverter (o teste disse que piorou: voltar titulo_antes/descricao_antes, ou o que estava antes no git se vierem nulos): ${j(p.titulos.reverter)}
Como: ache o arquivo da página pela URL (slug no frontmatter/rota; o campo "arquivo" diz onde foi da última vez); troque SÓ o title/titulo e a description do frontmatter ou do head; NÃO mude o H1 nem a URL nem o texto; se o título do post e o H1 vêm do mesmo campo, prefira um campo separado de SEO (seoTitle/metaTitle) se o layout já tiver um, senão deixe o H1 acompanhar e diga na nota. Publique junto com o resto. Devolva uma entrada em "titulos" por item (mesmo id) com o caminho do arquivo.
`
    : ""
}O QUE VOCÊ CORRIGE SOZINHO (e publica)
- Link interno quebrado: aponte para a página certa (procure pelo slug no conteúdo/rotas) ou, se a página não existe mais, tire o link mantendo o texto.
- Link de afiliado sem domínio ou com o padrão errado: use o link completo e correto conforme o config do projeto (ex.: enLink()/AFFILIATE), mantendo ref e utm_campaign.
- Link externo que dá 404 de verdade: confirme com WebFetch; se a página mudou de endereço e você ACHA o novo com certeza, troque; se não, tire o link mantendo o texto. Link externo "sem resposta" (status null) que responde para você: não mexa; ponha em "descartes" com tipo "link" (URL exata do link) e motivo "respondeu 200 aqui; bloqueia o robô do painel". O painel então tira da lista e para de testar.
- SEO de página: meta description faltando ou fora do tamanho, title fora de 20-65, mais de um H1, imagem sem alt, canonical faltando. Corrija no post (frontmatter) ou no layout. Alt e description descrevem o que existe: nada inventado, nenhum fato novo.
- Implementações de SEO faltando (faltas.mecanicas): corrija no LAYOUT/head do site, uma vez, para valer em todas as páginas: Open Graph (og:title, og:description, og:image com a capa do post ou a imagem padrão do site, og:url, og:type article nos posts), twitter:card summary_large_image, <html lang="pt-BR">, viewport, favicon, JSON-LD (BlogPosting/Article nos posts com headline, datePublished, dateModified, author e image que JÁ existem no frontmatter; WebSite na home; BreadcrumbList onde há trilha), robots.txt com a linha "Sitemap: <url do sitemap>". Use só dados que já existem no projeto (nome, logo, descrição do config); nunca invente autor, endereço ou telefone. llms.txt e dados da organização que não existem no projeto: relate em para_o_rammer.
- Página curta (< 300 palavras) que é listagem, índice, paginação, glossário, política, autor ou página de contato: NÃO encher de texto; ponha em "descartes" com tipo "pagina_curta" (URL da página) e o motivo. O painel para de contar. Página de conteúdo curta de verdade (post, pilar) fica em "para_o_rammer".
- Imagem com alt="" (vazio) CONTA como sem alt quando é foto de produto, de ambiente, de pessoa ou capa de post (o painel conta assim): escreva um alt curto dizendo o que a foto mostra, a partir do texto que está ao lado dela no mesmo componente/página. Só deixe alt="" em ícone/ornamento puro (traço, fundo, logo repetida ao lado do nome escrito). Procure em src/pages, src/components e src/layouts, não só nos posts.
- Carregamento no celular acima de 2,5 s (carregamento.lento): rode o PageSpeed na URL do site (WebFetch em https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?url=<site>&strategy=mobile&category=performance) e leia qual elemento é o LCP e as auditorias que falham. É MECÂNICO e você corrige quando a causa for: imagem do topo grande ou sem tamanho/formato moderno (gere webp/avif no tamanho certo, width/height, fetchpriority="high" e <link rel="preload"> na imagem do LCP, loading="lazy" só nas fora da dobra), fonte sem preload/font-display, CSS ou JS bloqueando a renderização (defer, inline só o crítico), muitas imagens na home sem lazy. Sem mudar o design nem trocar fotos. NUNCA embuta o CSS inteiro no HTML (inlineStylesheets: 'always' ou equivalente): a regra da casa é CSS em arquivo com cache (docs/18) e o painel acusa página com mais de 10 kB de CSS dentro do HTML; em 28/10/2026 isso virou um vai-e-volta na VK. Se o que sobra for só o arquivo de CSS, relate. Se a causa for o servidor (TTFB alto) ou precisar de decisão, só relate.
- Links /cdn-cgi/ e mailto: nunca são problema.
- "descartes" vale para sempre: o painel fecha o item e não reabre. Só use quando CONFIRMOU (link: viu 200; página: viu que é índice/listagem).

O QUE VOCÊ NÃO FAZ
- Não altera o texto dos posts além do link/alt/description; não muda pubDate; não mexe em preços, fatos, promessas; não muda design; não cria post; não apaga post.
- Site fora do ar, robô de posts parado, feed com erro, coisa que precisa de senha/API/decisão: só relata em "para_o_rammer", curto e concreto.
- Nada de \`git push --force\`, nada de apagar branch, nada fora desta pasta.

PUBLICAR
- Antes: se existir build (\`npm run build\` ou o que o CLAUDE.md mandar), ele tem que passar.
- Commit em main com mensagem começando por "Revisão automática do Métricas:" e terminando com a linha "Co-Authored-By: Claude <noreply@anthropic.com>". Publicação pelo fluxo do projeto: push (Vercel/Cloudflare Pages publicam no push), \`bash deploy/deploy.sh\` (blog EN) ou \`npm run deploy\` (Worker), conforme o CLAUDE.md.
- Registre uma linha datada de hoje no arquivo de registro que o CLAUDE.md do projeto manda usar (STATUS.md, INSTRUCOES.md, CLAUDE.md...): "Revisão automática do Métricas: <o que mudou>". Se nada foi corrigido, não registre nada.
- Se nada havia para corrigir, devolva corrigido=[] e publicado=false.

RESPOSTA: só o JSON do esquema (corrigido, para_o_rammer, ignorado, descartes, publicado, resumo, acoes, titulos), frases curtas em português, uma por item, com o caminho/URL envolvido. "acoes", "descartes" e "titulos" vazios se não houver.`;
}

// Contas: conta1/conta2 revezam, conta3 de reserva (robo/contas.mjs). Em 06/10/2026
// a conta da sessão bateu o limite semanal e a rodada falhou nos 6 projetos enquanto as outras tinham cota.
function rodarClaude(prompt, cwd) {
  const args = [
    "-p",
    "--model", MODELO,
    "--output-format", "json",
    "--json-schema", ESQUEMA,
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    "--allowedTools", ["Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "Bash(git:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(bash:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(curl:*)"].join(","),
    "--disallowedTools", ["Agent", "NotebookEdit", "Workflow"].join(","),
  ];
  return rodarClaudeComContas(args, prompt, cwd, { tempoMaxMs: TEMPO_MAX_MS, log });
}

function extrairResultado(r) {
  try {
    const j = JSON.parse(r.saida);
    const so = j.structured_output ?? (typeof j.result === "string" ? JSON.parse(j.result) : j.result);
    if (so && Array.isArray(so.corrigido)) return { so, custo: j.total_cost_usd ?? null };
  } catch {}
  return null;
}

async function revisarProjeto(p) {
  let pasta = null;
  let publicacao = null;
  if (NA_NUVEM) {
    const conhecido = (await mapaDeProjetos())[p.id];
    if (!conhecido) return { projeto_id: p.id, corrigido: [], para_o_rammer: [p.id === "piloto-humano" ? "Revisão automática na nuvem não cobre o Piloto Humano (o Worker dele só é publicado do Mac); entra quando o PH sair do Mac." : "Projeto sem repositório conhecido pelo robô na nuvem (nem da casa, nem no painel do Roda): a revisão automática não sabe onde corrigir."], publicado: false, erro: null };
    publicacao = conhecido.publicacao;
    try {
      pasta = await pastaDoProjeto(p.id, null);
      instalarDependencias(pasta);
    } catch (e) {
      return { projeto_id: p.id, corrigido: [], para_o_rammer: [], publicado: false, erro: `não consegui clonar ou instalar ${conhecido.repo}: ${String(e?.message ?? e).slice(0, 200)}`, duracao_s: 0, custo_usd: null, modelo: MODELO };
    }
  } else {
    if (!p.pasta) return { projeto_id: p.id, corrigido: [], para_o_rammer: ["Projeto sem pasta cadastrada no painel (Ajustes): a revisão automática não sabe onde corrigir."], publicado: false, erro: null };
    pasta = await pastaDoProjeto(p.id, p.pasta);
    if (!pasta) return { projeto_id: p.id, corrigido: [], para_o_rammer: [`Pasta ${p.pasta} não existe neste Mac.`], publicado: false, erro: null };
  }
  log(`${p.id}: ${p.links_quebrados.length} link(s) quebrado(s), ${p.seo.piores_paginas.length} página(s) com SEO a melhorar, ${(p.acoes ?? []).length} ação(ões) de inteligência, ${(p.titulos?.aplicar ?? []).length} título(s) a testar, ${(p.titulos?.reverter ?? []).length} a reverter → claude em ${pasta}`);
  const r = await rodarClaude(montarPrompt(p, publicacao), pasta);
  if (r.tipo === "sem_cota_todas") {
    log(`${p.id}: nenhuma conta do Claude com cota (${r.mensagem})`);
    return { projeto_id: p.id, corrigido: [], para_o_rammer: [], publicado: false, erro: `o Claude está sem cota em todas as contas (${r.mensagem})`, duracao_s: 0, custo_usd: null, modelo: MODELO };
  }
  const res = extrairResultado(r);
  if (!res) {
    log(`${p.id}: claude não devolveu JSON (código ${r.codigo}, ${r.duracao}s, conta ${r.conta}):`, (r.erro || r.saida).slice(0, 600));
    return { projeto_id: p.id, corrigido: [], para_o_rammer: [], publicado: false, erro: `o Claude não concluiu (código ${r.codigo}, ${r.duracao}s, conta ${r.conta}${r.mensagem ? ": " + r.mensagem.slice(0, 160) : ""})`, duracao_s: r.duracao, custo_usd: null, modelo: MODELO };
  }
  log(`${p.id}: ${r.duracao}s, custo ${res.custo ?? "?"}, conta ${r.conta}: ${res.so.resumo}`);
  for (const x of res.so.corrigido) log(`  ✔ ${x}`);
  for (const x of res.so.para_o_rammer) log(`  → Rammer: ${x}`);
  for (const x of res.so.ignorado) log(`  · ignorado: ${x}`);
  for (const d of res.so.descartes ?? []) log(`  ✖ descarte ${d.tipo}: ${d.url} (${d.motivo})`);
  for (const a of res.so.acoes ?? []) log(`  🧠 ação ${a.id}: ${a.resultado} (${a.nota})`);
  for (const t of res.so.titulos ?? []) log(`  🔤 título ${t.id}: ${t.resultado} (${t.arquivo || "sem arquivo"}; ${t.nota})`);
  return { projeto_id: p.id, corrigido: res.so.corrigido, para_o_rammer: res.so.para_o_rammer, publicado: res.so.publicado, erro: null, duracao_s: r.duracao, custo_usd: res.custo, modelo: MODELO, acoes: res.so.acoes ?? [], descartes: res.so.descartes ?? [], titulos: res.so.titulos ?? [] };
}

async function principal() {
  if (!ehHoraDeRodar()) return; // passagem fora da janela, ou já rodou hoje: sai calado
  log(`gatilho automático: ${new Date().toLocaleTimeString("pt-BR")} (${NA_NUVEM ? "GitHub Actions" : `hora marcada ${String(Math.floor(horaMinima() / 60)).padStart(2, "0")}:${String(horaMinima() % 60).padStart(2, "0")}`})`);
  if (!NA_NUVEM && existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 3 * 60 * 60 * 1000) {
    log("outra revisão em andamento (lock); saindo");
    return;
  }
  if (!NA_NUVEM) writeFileSync(LOCK, String(process.pid));
  try {
    const r = await pendenciasComEspera();
    if (!r.ok) {
      log(`painel respondeu ${r.status}: ${r.texto.slice(0, 200)}`);
      if (NA_NUVEM) process.exitCode = 1;
      return;
    }
    // Conferência das contas do Claude (13/10/2026): o painel mostra de manhã quem tem cota e quem não tem. Na nuvem
    // só na primeira passagem do dia (antes das 9h): as retentativas não precisam gastar isso de novo.
    if (!SO && (!NA_NUVEM || new Date().getHours() < 9)) {
      try {
        const cc = await conferirContas({ log, modelo: MODELO });
        const g = await api("/api/rodada", { robo: "contas", estado: cc.estado, motivo: cc.motivo, custo_usd: cc.custo, modelo: MODELO });
        log(`contas do Claude: ${cc.motivo} (painel ${g.ok ? "ok" : g.status})`);
      } catch (e) {
        log(`conferência das contas falhou: ${e?.message ?? e}`);
      }
    }
    const projetos = r.dados.projetos.filter((p) => !SO || p.id === SO);
    log(`${projetos.length} projeto(s) no painel`);
    let comTrabalho = 0;
    let deuCerto = 0;
    let falhouPorCota = 0;
    for (const p of projetos) {
      // Rodada que falhou (erro gravado) não conta como revisão: em 06/10/2026 a das 08:57 falhou sem cota e a repetição pulava os 6.
      if (!SO && p.ultima_revisao && !p.ultima_revisao.erro && Date.now() / 1000 - p.ultima_revisao.em < 12 * 3600) {
        log(`${p.id}: já revisado há menos de 12 h; pulando`);
        continue;
      }
      if (!temTrabalho(p) && !SO) {
        log(`${p.id}: nada a corrigir`);
        await api("/api/revisao", { projeto_id: p.id, corrigido: [], para_o_rammer: p.resumo.filter((t) => /fora do ar|sem post|robô|feed/i.test(t)), publicado: false, erro: null, duracao_s: 0, custo_usd: 0, modelo: MODELO });
        continue;
      }
      const resultado = await revisarProjeto(p);
      comTrabalho++;
      if (resultado.erro) { if (/sem cota|token|não concluiu|credencial/i.test(resultado.erro)) falhouPorCota++; } else deuCerto++;
      const g = await api("/api/revisao", resultado);
      if (!g.ok) log(`${p.id}: painel não aceitou o registro (${g.status}): ${g.texto.slice(0, 200)}`);
      // publicou algo? pede ao painel para reler o site agora (o estado das implementações não espera a próxima hora)
      if (resultado.publicado && resultado.corrigido.length) {
        await esperar(90_000); // tempo de a Vercel/Pages/servidor subir o build
        const rl = await api(`/api/rastrear/${p.id}`, {});
        log(`${p.id}: releitura pedida ao painel (${rl.ok ? "ok" : rl.status})`);
      }
    }
    if (comTrabalho > 0 && deuCerto === 0 && falhouPorCota > 0 && !SO) marcarPendente(`o Claude falhou em ${falhouPorCota} projeto(s) por cota/credencial`);
    else marcarDia();
  } finally {
    if (!NA_NUVEM) { try { unlinkSync(LOCK); } catch {} }
  }
}

process.on("unhandledRejection", (e) => { log("promessa rejeitada:", e?.stack ?? e); process.exit(1); });
await principal();
