#!/usr/bin/env node
// Inteligência semanal do Métricas (pedido do Rammer em 03/10/2026: "quero que os meus projetos aprendam um com o
// outro; o que funciona em um, replicar no outro; automático; e uma aba Inteligência onde eu aprovo").
//
// Roda no Mac (launchd, segunda 08:30): lê GET /api/comparacao (os mesmos números de todos os projetos + consultas,
// páginas, publicações, origens, pins), pensa com o Claude Code (`claude -p`, pela assinatura, modelo Opus) e devolve
// POST /api/inteligencia uma lista de hipóteses com evidência, confiança, projeto de origem, projeto-alvo, ação e
// métrica a medir. No painel: mecânica nasce aprovada (o robô de revisão aplica no dia seguinte); estratégica espera
// o "sim" dele na aba Inteligência. Token: o mesmo da revisão (Keychain "Métricas - token de revisão").
// Log: ~/Library/Logs/metricas-inteligencia.log. Na mão: `node robo/inteligencia.mjs` (ou `--so-ler` para ver os dados).
//
// Desde 06/11/2026 roda no GitHub Actions (`.github/workflows/inteligencia.yml`): segunda 08:30 de Brasília e
// retentativas até dar certo na semana. Lá os projetos são clonados em `trabalho/meus-clientes/<id>` (só leitura) e
// o painel diz se a rodada da semana já deu certo (`GET /api/rodada?robo=inteligencia`).
import { rodarClaudeComContas } from "./contas.mjs";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NA_NUVEM, TRABALHO, api, apiComEspera, log, mapaDeProjetos, pastaDoProjeto, ultimaRodada } from "./nuvem.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MODELO = process.env.METRICAS_MODELO ?? "opus";
const CLIENTES = process.env.CLIENTES_DIR ?? TRABALHO; // cwd: pode ler as pastas dos projetos (só leitura)
const TEMPO_MAX_MS = 25 * 60 * 1000;
const LOCK = join(AQUI, "lock-inteligencia");
const ESQUEMA = readFileSync(join(AQUI, "esquema-inteligencia.json"), "utf8");
const SO_LER = process.argv.includes("--so-ler");

// Gatilho robusto (04/10/2026; ver revisar.mjs): o launchd chama a cada 30 min; roda uma vez por semana, na primeira
// passagem de segunda-feira a partir das 08:30 (hora do Mac). `--agora` ignora a janela.
const MARCA_SEMANA = join(AQUI, "ultima-inteligencia.txt"); // segunda-feira da última semana em que DEU CERTO (arquivo próprio: o ultima-rodada.txt é da revisão diária)
const PENDENTE = join(AQUI, "inteligencia-pendente.txt"); // hora da última tentativa que falhou (cota, erro, painel)
const TENTAR_DE_NOVO_MS = 2 * 60 * 60 * 1000;
// Regra do Rammer (13/10/2026): "se a regra é uma vez por semana, tem que acontecer toda semana". A rodada é devida
// a partir de segunda 08:30 e fica devida até dar certo: falhou (sem cota, Mac dormindo/desligado, erro) → a passagem
// de 5 min tenta de novo 2 h depois, em qualquer dia da semana. A marca da semana só é gravada no sucesso.
function segundaDaSemana(t = new Date()) {
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function ehHoraDeRodar() {
  if (process.argv.includes("--agora") || SO_LER) return true;
  const t = new Date();
  if (t.getDay() === 1 && t.getHours() * 60 + t.getMinutes() < 8 * 60 + 30) return false; // segunda antes das 08:30
  if (NA_NUVEM) {
    // o painel é a memória: deu certo desde a segunda 08:30 desta semana? então esta semana está feita
    const { ultima_ok } = await ultimaRodada("inteligencia");
    const inicio = new Date(`${segundaDaSemana(t)}T08:30:00-03:00`).getTime() / 1000;
    if (ultima_ok && ultima_ok.em >= inicio) { log(`a inteligência desta semana já deu certo (${new Date(ultima_ok.em * 1000).toLocaleString("pt-BR")}); nada a fazer`); return false; }
    return true;
  }
  if (existsSync(MARCA_SEMANA) && readFileSync(MARCA_SEMANA, "utf8").trim() === segundaDaSemana(t)) return false; // já deu certo nesta semana
  if (existsSync(PENDENTE) && Date.now() - Number(readFileSync(PENDENTE, "utf8").trim() || 0) < TENTAR_DE_NOVO_MS) return false; // falhou há pouco: espera 2 h
  return true;
}
function marcarSemana() {
  if (NA_NUVEM) return; // o painel gravou a rodada (robo "inteligencia", estado ok)
  writeFileSync(MARCA_SEMANA, segundaDaSemana());
  try { unlinkSync(PENDENTE); } catch {}
}
function marcarPendente(motivo) {
  if (NA_NUVEM) { log(`rodada incompleta (${motivo}); a próxima passagem do workflow tenta de novo`); process.exitCode = 1; return; }
  writeFileSync(PENDENTE, String(Date.now()));
  log(`rodada pendente (${motivo}); tento de novo em 2 h`);
}
const comparacaoComEspera = () => apiComEspera("/api/comparacao");

/** Na nuvem, clona (só leitura) todos os projetos que têm repositório, no desenho `meus-clientes/<id>` que o prompt descreve. */
async function prepararPastas(ids) {
  if (!NA_NUVEM) return;
  const mapa = await mapaDeProjetos();
  for (const id of ids) {
    if (!mapa[id]) { log(`${id}: sem repositório conhecido; a inteligência lê só os números dele`); continue; }
    try { await pastaDoProjeto(id, null); } catch (e) { log(`${id}: não consegui clonar (${String(e?.message ?? e).slice(0, 120)}); sigo sem a pasta`); }
  }
}

function montarPrompt(d) {
  const j = (x) => JSON.stringify(x);
  return `Você é a inteligência semanal do Métricas, o painel do Rammer. Ele tem vários projetos (blogs automáticos com links de afiliado, um SaaS, um site de serviço) e quer que UM PROJETO APRENDA COM O OUTRO: o que funciona num deles, replicado nos outros. Você recebe os números dos últimos 28 dias de todos (contra os 28 anteriores) e devolve hipóteses com evidência, cada uma virando UMA ação concreta num projeto-alvo. Ninguém lê sua resposta em tempo real: não faça perguntas.

OS NÚMEROS (28 dias; visitas = beacon próprio; busca = Google Search Console; seo = notas 0-100; afiliado_por_100 = cliques de afiliado por 100 visitas; tendencia = cresce/estavel/cai pela base que existe, "sem-base" quando não há dado suficiente):
${j(d.projetos)}

DETALHES POR PROJETO (consultas e páginas com mais cliques no Google e o CTR delas, publicações recentes com título, piores páginas em SEO, páginas mais vistas com cliques de afiliado e tempo mediano, origens de tráfego, pins com mais cliques):
${j(d.detalhes)}

PROSPECÇÃO DA ENSINO NACIONAL (campanhas de e-mail e WhatsApp disparadas pelo painel, com as fotos do resultado em 48 h, 7 e 30 dias: enviadas, abertos, cliques, respostas, trials = cartões cadastrados nos 7 dias grátis, pagaram = pessoas que pagaram de verdade (receita_centavos é o dinheiro), sem_pagar = entraram no plano Gratuito ou ficaram com cobrança pendente (R$ 0, NÃO é conversão), conversoes = número antigo que mistura os dois e deve ser ignorado, reclamaram = spam, motivos = por que as pessoas responderam; experimento/variante = teste A/B de assunto):
${j(d.prospeccao ?? [])}

TÍTULOS JÁ TESTADOS (resultado do ciclo de títulos: mantido = a variante ganhou; revertido = perdeu e voltou; empate; aprenda o PADRÃO que ganha em cada projeto): ${j(d.titulos_aprendizado ?? [])}

RADAR DE PAUTAS EM ALTA (o que o radar diário enfileirou e o que cada post rendeu em 14 dias; aprenda que fonte/tema traz gente): ${j(d.radar_aprendizado ?? [])}
CAPTURA DE E-MAIL por projeto está em "capturas" nos detalhes (total, 28 dias, páginas que mais capturam): proponha, como mecânica, onde o bloco de captura rende mais e em quais projetos instalar (componente CapturaEmail.astro já existe no Guia e no blog EN).

HIPÓTESES JÁ EM ABERTO (não repita; mesmo título e mesmo alvo = repetida): ${j(d.hipoteses_abertas)}
HIPÓTESES JÁ AVALIADAS (aprenda com o que confirmou e com o que foi descartado ou recusado): ${j(d.hipoteses_avaliadas)}

Você está na pasta ${CLIENTES} e pode LER (só ler) as pastas dos projetos em meus-clientes/<id>/ para entender como cada um escreve (títulos, estrutura dos posts, onde põe o link de afiliado, templates do robô de posts). Use isso para transformar um número em causa provável. Não edite nada.

COMO PENSAR
1. Primeiro o que diferencia: qual projeto tem a melhor taxa (afiliado por 100 visitas, visitas por artigo, CTR no Google, cliques por artigo) e O QUE ele faz de diferente dos outros (padrão de título, tamanho, onde está o link, origem do tráfego, cadência). Isso é a origem.
2. Depois o alvo: em qual projeto a mesma taxa está pior E a diferença é algo que dá para replicar.
3. Confiança: "alta" só quando os dois lados têm base (100+ impressões ou 50+ visitas no período) e a diferença é grande (2× ou mais); "media" quando há base de um lado só ou diferença menor; "baixa" quando é comparação de estrutura sem número forte. Com tráfego pequeno, a maioria será media/baixa: diga isso, não infle.
4. Nada inventado: a evidência cita só números que vieram acima. Sem prova social, preço, promessa. Se um projeto está "sem-base", ele pode ser alvo (aprender), não origem.
5. Tipo (REGRA DO RAMMER, 15/10/2026, "usuário root, 100% de liberdade, não precisa me pedir"): "mecanica" = TUDO que traz público, engajamento, SEO ou presença em busca por IA e que o robô de revisão consegue fazer na pasta sem senha: title, meta description, alt, links internos, H1, canonical, dados estruturados (FAQPage, HowTo, BreadcrumbList, ItemList, Organization/sameAs), Open Graph/Twitter, llms.txt e qualquer técnica de GEO (aparecer em respostas de IA: resumo direto no topo, perguntas e respostas, definições, tabelas, fonte citada), sitemap/feed/robots, Core Web Vitals, estrutura/ordem de blocos em páginas que já existem, posição do link de afiliado, FILA DE PAUTAS do projeto (acrescentar pautas em pautas.md nos clusters que trazem cliques e em consultas de cauda longa com impressão; marcar "descartada (fora do cluster)" as livres), palavras-chave e cauda longa nos posts, formato de conteúdo que o momento pede (checklist, tabela, passo a passo, modelo para copiar, material para baixar feito com o que já existe no projeto), ajuste do prompt/modelo do robô de posts, e a estratégia editorial do projeto quando condiz com o território dele. "estrategica" (ele aprova antes) = só o que muda o LAYOUT/design do site, oferta/preço, território ou público do projeto, coisa que precisa de senha/API/conta nova, ou captura de e-mail que ainda não tem destino. Continuam proibidos sempre: fato, preço, prova social, promessa inventados.
6. Ação: concreta, executável por um robô NA PASTA do projeto-alvo, sem precisar de senha ou API ("nos 10 posts mais vistos, mover o bloco de link de afiliado para logo após o primeiro H2, como o Guia faz"; "ajustar o prompt do robô de posts para títulos em forma de pergunta de até 60 caracteres, padrão que no Tutor tem CTR 2× maior"). Nunca "analisar", "considerar", "avaliar": isso não é ação.
7. Métrica: a que deve mudar em 28 dias se a hipótese estiver certa. Posição = posicao_28; cliques de afiliado = afiliado_28; cliques no Google = busca_cliques_28; visitas = visitas_28; CTR = ctr_28. null só se não há como medir.
8. Entre 0 e 8 hipóteses. Semana sem nada que valha a pena = lista vazia e o resumo explica por quê. Qualidade sobre quantidade.
9. AUDITORIA DE SEO DE PONTA (pedido do Rammer, 04/10/2026: "coisas que eu nem pensaria, por não conhecer"): além dos números, olhe o CÓDIGO de cada site (você tem leitura em ~/Documents/Clientes: layouts, heads, astro.config, sitemap, robots, feeds, componentes de post) e o campo "implementacoes" de cada projeto, e proponha o que um especialista de SEO faria e ainda não está feito: dados estruturados que faltam (FAQPage em posts com perguntas, BreadcrumbList, Organization/WebSite com sameAs, ItemList em listagens), trilha de navegação, links internos entre posts relacionados, paginação com rel prev/next, imagens com width/height e loading, sitemap com lastmod, página 404 útil, headings em ordem, texto âncora descritivo, canonical em paginação, hreflang quando houver idioma, pré-conexão de fontes, Core Web Vitals. Cada achado vira UMA hipótese: tipo "mecanica" quando é mudança de layout/template sem fato novo (vai para o robô diário sozinho); "estrategica" quando precisa de conteúdo, decisão ou dado que não existe no projeto. Evidência = o arquivo/tag onde você viu que falta. Métrica = a que deve melhorar (busca_cliques_28, posicao_28 ou ctr_28).

11. ESTRATÉGIA EDITORIAL QUE APRENDE SOZINHA (regra do Rammer, 13/10/2026: "cada projeto tem que aprender com o próprio histórico e adaptar a estratégia sem eu vir aqui"): para CADA blog, toda semana, com paginas_busca_top, consultas_top e paginas_mais_vistas: (a) diga quais clusters de assunto trazem cliques e impressões (os vencedores) e quais posts/pautas não trazem nada; (b) leia o pautas.md do projeto (meus-clientes/<id>/pautas.md ou site/pautas.md) e proponha UMA hipótese mecânica por projeto com a ação completa: acrescentar de 5 a 8 pautas novas em pautas.md, cada uma nascida de uma consulta ou página com impressões (cite a consulta/página na pauta) e dentro de um cluster vencedor, e marcar como "descartada (fora do cluster, inteligência AAAA-MM-DD)" as pautas livres fora dos vencedores; (c) proponha a reescrita de title e meta description das páginas com 30+ impressões e CTR abaixo de 1% (mecânica, uma hipótese por projeto, listando as URLs); (d) compare o ritmo: se o projeto publicou mais e os cliques não subiram, diga isso no resumo e NÃO proponha mais volume; (e) cite o que funciona num projeto e falta no outro (ex.: cluster de verificação de certificado no Guia; suporte da plataforma no blog EN). Respeite o CLAUDE.md de cada projeto (território, público, proibições). Métrica: busca_cliques_28 para pautas, ctr_28 para snippets.
12. CICLO DE TÍTULOS (15/10/2026; docs/20): cada projeto traz "titulos_candidatos": páginas com 100+ impressões em 28 dias e CTR abaixo de 70% do esperado para a posição (desempenho < 0,7). Para CADA candidata devolva UMA entrada em "titulos": projeto, a url exata, título novo (20-65 caracteres), descrição nova (50-160) e por_que (a hipótese: o que muda na abordagem). Leia o post na pasta do projeto antes (o título tem que descrever o que a página entrega; nada de isca, número inventado, promessa). Varie a ABORDAGEM, não só as palavras: pergunta direta, benefício concreto, "como fazer", "o que é", "vale a pena?", número real que está no texto, nome da entidade buscada (veja consultas_top). Aprenda com "TÍTULOS JÁ TESTADOS": repita o padrão que ganhou no projeto, evite o que perdeu. Se ciclo > 1, a abordagem tem que ser diferente da anterior (titulo_atual). Sem candidatas = "titulos" vazio. Título em teste NÃO entra como hipótese (o ciclo já mede sozinho).
10. PROSPECÇÃO (08/10/2026): com o histórico acima, compare público × assunto × perfil (pessoal/empresa) × dia da semana × canal pela taxa de trials (cartões), de pagaram e pela receita_centavos; sem_pagar não é conversão (é plano Gratuito, R$ 0) e nunca justifica priorizar um público; nunca por abertura sozinha; reclamação acima de 0,1% é alarme. Hipótese com alvo_projeto "prospeccao", tipo "estrategica" (ele aprova; aparece no fluxo "Iniciar campanha"), metrica null, origem_projeto null. Ação concreta: qual público mandar em seguida e com qual assunto/texto, qual variante do A/B virou padrão, que objeção (motivos) o próximo texto deve atacar, quando parar. Confiança "alta" só com 200+ enviadas dos dois lados e diferença de 2× ou mais. Sem campanha medida: nenhuma hipótese de prospecção.

RESPOSTA: só o JSON do esquema (resumo, hipoteses, titulos), em português, frases curtas.`;
}

// Contas: conta1/conta2 revezam, conta3 de reserva (robo/contas.mjs).
function rodarClaude(prompt, cwd) {
  const args = ["-p", "--model", MODELO, "--output-format", "json", "--json-schema", ESQUEMA, "--no-session-persistence", "--permission-mode", "dontAsk", "--strict-mcp-config", "--allowedTools", ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(git log:*)"].join(","), "--disallowedTools", ["Agent", "Edit", "Write", "NotebookEdit", "Workflow", "WebFetch"].join(",")];
  return rodarClaudeComContas(args, prompt, cwd, { tempoMaxMs: TEMPO_MAX_MS, log });
}

function extrairResultado(r) {
  try {
    const j = JSON.parse(r.saida);
    const so = j.structured_output ?? (typeof j.result === "string" ? JSON.parse(j.result) : j.result);
    if (so && Array.isArray(so.hipoteses)) return { so, custo: j.total_cost_usd ?? null };
  } catch {}
  return null;
}

async function principal() {
  if (!(await ehHoraDeRodar())) return;
  if (!NA_NUVEM && existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 3 * 60 * 60 * 1000) {
    log("outra rodada em andamento (lock); saindo");
    return;
  }
  if (!NA_NUVEM) writeFileSync(LOCK, String(process.pid));
  try {
    const r = await comparacaoComEspera();
    if (!r.ok) {
      log(`painel respondeu ${r.status}: ${r.texto.slice(0, 200)}`);
      marcarPendente("painel não respondeu");
      return;
    }
    const d = r.dados;
    log(`${d.projetos.length} projeto(s); ${d.hipoteses_abertas.length} hipótese(s) em aberto; ${d.hipoteses_avaliadas.length} avaliada(s)`);
    if (SO_LER) {
      console.log(JSON.stringify(d, null, 1));
      return;
    }
    await prepararPastas(d.projetos.map((p) => p.id));
    const resultado = await rodarClaude(montarPrompt(d), existsSync(CLIENTES) ? CLIENTES : AQUI);
    // Falha vai ao painel com o motivo (13/10/2026): a grade mostra "Inteligência falhou: por quê" no mesmo dia.
    const falhou = async (motivo) => { try { await api("/api/rodada", { robo: "inteligencia", estado: "falha", motivo, duracao_s: resultado.duracao, modelo: MODELO, conta: resultado.conta ?? null }); } catch {} };
    if (resultado.tipo === "sem_cota_todas") {
      log(`nenhuma conta do Claude com cota (${resultado.mensagem})`);
      await falhou(`todas as contas sem cota ou com token inválido (${resultado.mensagem})`);
      marcarPendente("sem cota");
      return;
    }
    const res = extrairResultado(resultado);
    if (!res) {
      log(`claude não devolveu JSON (código ${resultado.codigo}, ${resultado.duracao}s, conta ${resultado.conta}):`, (resultado.erro || resultado.saida).slice(0, 600));
      await falhou(`o Claude não devolveu as hipóteses (código ${resultado.codigo}, ${resultado.duracao}s, conta ${resultado.conta}): ${(resultado.erro || resultado.saida).replace(/\s+/g, " ").slice(0, 160)}`);
      marcarPendente("o Claude não devolveu as hipóteses");
      return;
    }
    log(`${resultado.duracao}s, custo ${res.custo ?? "?"}, conta ${resultado.conta}: ${res.so.resumo}`);
    for (const h of res.so.hipoteses) log(`  💡 [${h.tipo}/${h.confianca}] ${h.origem_projeto ?? "geral"} → ${h.alvo_projeto}: ${h.titulo}`);
    const rodada = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    for (const t of res.so.titulos ?? []) log(`  🔤 ${t.projeto} ${t.url}: "${t.titulo}"`);
    const g = await api("/api/inteligencia", { rodada, hipoteses: res.so.hipoteses, titulos: res.so.titulos ?? [], custo_usd: res.custo, duracao_s: resultado.duracao, modelo: MODELO });
    if (!g.ok) { log(`painel não aceitou (${g.status}): ${g.texto.slice(0, 200)}`); marcarPendente("painel não aceitou"); }
    else { marcarSemana(); log(`painel: ${g.dados.criadas} criada(s), ${g.dados.repetidas} repetida(s), ${g.dados.recusadas.length} recusada(s)${g.dados.recusadas.length ? ": " + g.dados.recusadas.join(" | ") : ""}; títulos: ${g.dados.titulos_criados ?? 0} em teste${(g.dados.titulos_recusados ?? []).length ? ", recusados: " + g.dados.titulos_recusados.join(" | ") : ""}`); }
  } finally {
    if (!NA_NUVEM) { try { unlinkSync(LOCK); } catch {} }
  }
}

process.on("unhandledRejection", (e) => { log("promessa rejeitada:", e?.stack ?? e); process.exit(1); });
await principal();
