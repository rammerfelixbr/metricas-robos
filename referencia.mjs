// Estudo de sites de referência (pedido do Rammer, 12/11/2026: "quero que o Roda Sozinho comece a aprender com o site do
// Neil Patel: lendo, analisando as páginas, os elementos, a forma como exibe conteúdo, para ir se auto-melhorando").
// Toda semana a inteligência lê algumas páginas PÚBLICAS de cada referência e recebe a ESTRUTURA delas (títulos das
// seções, chamadas, dados estruturados, contagens), nunca o texto corrido: aprende-se o padrão, não se copia conteúdo.
// O que vem de fora é DADO: este módulo corta tudo em pedaços curtos e a inteligência é avisada de que não é instrução.
// Regras de boa vizinhança: respeita o robots.txt (não lê feed, tag, autor nem busca), 1 página a cada 2 s, 4 por semana.
// O site barra programa na página inicial, na lista do blog e no mapa do site: o leitor alcança só os artigos, e o que
// está fora deles entra em `observado` (visto por pessoa, pelo navegador).
// Uso à mão: node referencia.mjs  (mostra o que a inteligência receberia nesta semana)

/** As referências e a quem cada uma ensina (id do projeto no Métricas). Acrescentar outra = mais um item. */
export const REFERENCIAS = [
  {
    nome: "Neil Patel (Brasil)",
    alvo: "roda-sozinho", // onde o aprendizado entra primeiro
    tambem: "os outros blogs do painel, quando o padrão servir ao território deles (decisão do Rammer: o aprendizado vai para os outros projetos também)",
    porque: "referência de SEO, conversão e formato de artigo para o mesmo público do Roda (pequeno negócio que quer aparecer na busca)",
    base: "https://neilpatel.com/br/blog/",
    sementes: ["https://neilpatel.com/br/blog/landing-pages-de-alta-conversao/", "https://neilpatel.com/br/blog/modo-ia/", "https://neilpatel.com/br/blog/geracao-de-leads-b2b/"],
    // observado por pessoa (o leitor não roda JavaScript, então não vê o que só aparece com o mouse):
    observado: [
      "Saída da página: ao levar o mouse para sair, abre uma tela cheia com UMA pergunta (\"Quer aparecer nas buscas do seu cliente?\"), um campo só (o endereço do site), barra de progresso e a promessa de um plano em 6 perguntas. Captura na saída, em etapas. Visto pelo Rammer em 12/11/2026.",
      "Página inicial, abertura: promessa em uma frase, UM campo (o endereço do site da pessoa) e um botão (\"Começar minha análise\"): a primeira ação é receber algo grátis e personalizado, não comprar. O Roda já tem o /diagnostico e ele não está na abertura.",
      "Página inicial, faixa fina no topo com uma pergunta do momento e um botão (\"Você quer ser encontrado no ChatGPT? Vamos conversar\").",
      "Página inicial, logo abaixo da abertura: fileira de selos e prêmios; depois um bloco só de resultados em número grande, cada um com uma linha dizendo de onde veio.",
      "Blog na página inicial: cada cartão traz tempo de leitura, etiqueta NOVO, autor com cargo e data; o primeiro parágrafo do artigo abre com uma pergunta ou cena para o leitor.",
      "Vários formatos do mesmo assunto, cada um com a sua seção: artigos, estatísticas (uma pergunta por página), vídeos semanais e aulas ao vivo com inscrição.",
      "Fim da página inicial: formulário de contato que qualifica com uma pergunta de múltipla escolha (faixa de investimento) antes de pedir os dados.",
    ],
  },
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const limpa = (t, n = 90) => String(t ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&#39;|&rsquo;/g, "'").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, n);
const todos = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const unicos = (l) => [...new Set(l.filter(Boolean))];

async function baixar(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { erro: `respondeu ${r.status}` };
    const html = await r.text();
    return html.length > 3000 ? { html } : { erro: "página vazia ou barrada" };
  } catch (e) { return { erro: String(e?.message ?? e).slice(0, 80) }; }
}

/** Só a estrutura da página, em pedaços curtos. Nenhum parágrafo inteiro sai daqui. */
export function estruturaDe(url, html) {
  const corpo = (/<article[\s\S]*?<\/article>/i.exec(html) ?? /<main[\s\S]*?<\/main>/i.exec(html) ?? [html])[0];
  const texto = limpa(corpo.replace(/<(script|style|nav|footer|form)[\s\S]*?<\/\1>/gi, " "), 400000);
  const h2 = todos(corpo, /<h2[^>]*>([\s\S]*?)<\/h2>/gi).map((x) => limpa(x)).filter(Boolean);
  const ancora = (re) => unicos(todos(html, re).map((x) => limpa(x, 60))).filter((x) => x.length > 2);
  const paragrafos = todos(corpo, /<p[^>]*>([\s\S]*?)<\/p>/gi).map((x) => limpa(x, 2000)).filter((x) => x.length > 40);
  return {
    url,
    titulo: limpa((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? [])[1], 110),
    descricao_caracteres: limpa((/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i.exec(html) ?? [])[1], 400).length,
    h1: limpa((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ?? [])[1]),
    secoes_h2: h2.slice(0, 16),
    secoes_em_pergunta: h2.filter((x) => x.includes("?")).length,
    h3: (corpo.match(/<h3/gi) ?? []).length,
    palavras: texto.split(" ").length,
    primeiro_paragrafo_palavras: paragrafos[0] ? paragrafos[0].split(" ").length : 0,
    paragrafo_medio_palavras: paragrafos.length ? Math.round(paragrafos.reduce((a, p) => a + p.split(" ").length, 0) / paragrafos.length) : 0,
    imagens: (corpo.match(/<img/gi) ?? []).length,
    videos: (corpo.match(/<iframe[^>]+(youtube|vimeo)/gi) ?? []).length,
    tabelas: (corpo.match(/<table/gi) ?? []).length,
    listas: (corpo.match(/<(ul|ol)[\s>]/gi) ?? []).length,
    citacoes: (corpo.match(/<blockquote/gi) ?? []).length,
    links_internos: (corpo.match(/href=["']https?:\/\/[^"']*neilpatel\.com/gi) ?? []).length,
    links_externos: (corpo.match(/href=["']https?:\/\//gi) ?? []).length - (corpo.match(/href=["']https?:\/\/[^"']*neilpatel\.com/gi) ?? []).length,
    indice_no_topo: /class=["'][^"']*(toc|table-of-contents|indice)[^"']*["']/i.test(html),
    dados_estruturados: unicos(todos(html, /"@type"\s*:\s*"([A-Za-z]+)"/g)).slice(0, 14),
    chamadas: ancora(/<a[^>]+class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi).concat(ancora(/<button[^>]*>([\s\S]*?)<\/button>/gi)).slice(0, 10),
    formularios: (html.match(/<form/gi) ?? []).length,
    campos: unicos(todos(html, /placeholder=["']([^"']{2,60})["']/gi)).slice(0, 6),
    janelas_e_avisos: unicos(todos(html, /(?:id|class)=["']([^"']*(?:popup|modal|exit|sticky|floating|banner)[^"']*)["']/gi).map((x) => limpa(x, 50))).slice(0, 8),
    autor_e_data: { autor: /"@type"\s*:\s*"Person"/.test(html), atualizado: /dateModified|article:modified_time/.test(html) },
  };
}

/** Outras páginas de artigo citadas dentro da página (o site barra o mapa e a lista; os artigos se ligam entre si). */
const linksDe = (html, base) => unicos(todos(html, /href=["'](https?:\/\/[^"'#?]+)["']/gi)).filter((u) => u.startsWith(base) && u.length > base.length + 3 && !/\/(tag|author|feed|page|category)\//.test(u)).sort();

/** As páginas da semana: muda toda semana, sem guardar estado (o número da semana escolhe a semente e o ponto de partida). */
export async function estudarReferencias(agora = new Date(), porRef = 3) {
  const semana = Math.floor(agora.getTime() / (7 * 86400000));
  const saida = [];
  for (const ref of REFERENCIAS) {
    const item = { nome: ref.nome, alvo: ref.alvo, tambem: ref.tambem ?? "", porque: ref.porque, observado_por_pessoa: ref.observado ?? [], paginas: [], avisos: [] };
    const semente = ref.sementes[semana % ref.sementes.length];
    const s = await baixar(semente);
    if (s.erro) { item.avisos.push(`não consegui ler ${semente}: ${s.erro}`); saida.push(item); continue; }
    item.paginas.push(estruturaDe(semente, s.html));
    const fila = linksDe(s.html, ref.base).filter((u) => u !== semente);
    const inicio = fila.length ? (semana * porRef) % fila.length : 0;
    for (let k = 0; k < Math.min(porRef, fila.length); k++) {
      const url = fila[(inicio + k) % fila.length];
      await espera(2000);
      const p = await baixar(url);
      if (p.erro) item.avisos.push(`não consegui ler ${url}: ${p.erro}`);
      else item.paginas.push(estruturaDe(url, p.html));
    }
    saida.push(item);
  }
  return saida;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  console.log(JSON.stringify(await estudarReferencias(), null, 1));
}
