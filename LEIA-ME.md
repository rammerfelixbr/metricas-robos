# Robôs do Métricas

Desde 11/11/2026 a revisão diária, a inteligência semanal, o radar de pautas e a fila do IndexNow rodam no GitHub Actions
deste repositório (`.github/workflows/`), para não dependerem do Mac. Os tokens ficam nos segredos do repositório
(`METRICAS_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `_2`, `_3`, `ROBOS_GITHUB_TOKEN`); nenhum valor está no código.
`nuvem.mjs` concentra o que muda na nuvem: token pelo ambiente, projetos clonados de `main` em `trabalho/`, e o painel
como memória. A reserva dos artigos saiu daqui e roda no painel do Roda Sozinho. O resto deste arquivo descreve cada
robô como ele era chamado no Mac (launchd), caminho que fica de reserva.

## Revisão automática diária

Todo dia às 07:30 o Mac roda `revisar.mjs` (launchd `br.com.metricas.revisao`): lê as pendências de cada projeto no
painel (`/api/pendencias`), abre o Claude Code na pasta do projeto, corrige o que é seguro (links quebrados, link de
afiliado errado, meta description/title/alt/canonical), publica pelo fluxo do projeto e devolve ao painel
(`/api/revisao`). O que precisa do Rammer aparece na grade, em "Revisão automática".

- Token: Keychain "Métricas - token de revisão" = `REVISAO_TOKEN` do Worker (ver `docs/06-revisao-automatica.md`).
- Log: `~/Library/Logs/metricas-revisao.log`.
- Na mão: `node robo/revisar.mjs` (todos) ou `node robo/revisar.mjs guia-do-certificado` (um só, ignora o "já revisado há < 12 h").
- Instalar/recarregar o agendamento: `cp robo/br.com.metricas.revisao.plist ~/Library/LaunchAgents/ && launchctl unload ~/Library/LaunchAgents/br.com.metricas.revisao.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/br.com.metricas.revisao.plist`.

## Inteligência semanal (`inteligencia.mjs`)

Toda segunda às 08:30 (launchd `br.com.metricas.inteligencia`): lê a comparação de todos os projetos no painel
(`/api/comparacao`), pensa com o Claude Code (só leitura, na pasta `~/Documents/Clientes`) e devolve hipóteses
(`/api/inteligencia`). Mecânicas nascem aprovadas e o `revisar.mjs` aplica no dia seguinte; estratégicas esperam o
"sim" do Rammer na aba Inteligência. Regras em `docs/09-inteligencia.md`.

- Mesmo token da revisão. Log: `~/Library/Logs/metricas-inteligencia.log`.
- Na mão: `node robo/inteligencia.mjs` (uma rodada agora) ou `node robo/inteligencia.mjs --so-ler` (só mostra os dados).
- Instalar/recarregar: `cp robo/br.com.metricas.inteligencia.plist ~/Library/LaunchAgents/ && launchctl unload ~/Library/LaunchAgents/br.com.metricas.inteligencia.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/br.com.metricas.inteligencia.plist`.

## Reserva dos robôs de posts do GitHub (`posts-reserva.mjs`, 15/10/2026; DESLIGADA no Mac em 10/11/2026: o painel do Roda faz isso, `painel/src/robo-reserva.ts`)

O cron do GitHub Actions é "melhor esforço": em 14/10/2026 só 3 das 6 passagens de VK, Guia, Tutor e Roda dispararam, e em
15/10 a das 10h07 não tinha disparado às 11h30, com as contas do Claude com cota. A cada 5 min (launchd
`br.com.metricas.posts-reserva`, também no login), a partir das 11h, o script confere pelo `gh` se cada um dos 4 tem commit
`post:` hoje (dia de Brasília) e, se não tem, dispara o `robo-diario.yml` (1× a cada 2 h, 4×/dia, nunca com rodada em
andamento). O robô disparado decide sozinho se publica. Cada disparo vai ao painel (`POST /api/rodada`, robô
`posts-reserva:<id>`, custo zero). Blog EN (cron no servidor) e Piloto Humano (launchd no Mac) não precisam: os gatilhos
deles são confiáveis.

- Usa o `gh` já logado neste Mac (conta rammerfelixbr, keyring); sem token novo. Marca por projeto em `robo/reserva-<id>.txt`.
- Log: `~/Library/Logs/metricas-posts-reserva.log`. Na mão: `node robo/posts-reserva.mjs --testar` (só relata).
- Instalar/recarregar: `cp robo/br.com.metricas.posts-reserva.plist ~/Library/LaunchAgents/ && launchctl bootout gui/$(id -u)/br.com.metricas.posts-reserva 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/br.com.metricas.posts-reserva.plist`.

## Radar diário de pautas em alta (`radar.mjs`, 15/10/2026; `docs/21-radar-captura.md`)

- Todo dia a partir das 09:00 (launchd a cada 30 min + no login; uma vez por dia; falhou → tenta em 2 h): lê `GET /api/radar`
  (território, consultas do Google, pautas já enfileiradas e o que renderam), o Google Trends BR e o Google News dos
  termos de cada projeto (`TERMOS` no script), e o Claude decide 0 ou 1 pauta urgente por projeto.
- Pauta aceita → linha no TOPO do `pautas.md` do projeto (status `livre (urgente, radar …)`), commit + push em `main`,
  `gh workflow run robo-diario.yml` nos projetos do GitHub. Blog EN: o cron do servidor faz `git pull`. PH fica fora.
- Na rodada seguinte confere se virou post (`publicada (data) — slug`) e avisa o painel; 14 dias depois o cron mede.
  Marcas: `robo/ultimo-radar.txt`, `robo/radar-enfileiradas.json`. Log: `~/Library/Logs/metricas-radar.log`.
- Na mão: `node robo/radar.mjs --agora` (uma rodada) ou `--so-ler` (só mostra as fontes).
- Instalar/recarregar: `cp robo/br.com.metricas.radar.plist ~/Library/LaunchAgents/ && launchctl bootout gui/$(id -u)/br.com.metricas.radar 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/br.com.metricas.radar.plist`.

## Leads quentes do Ensino Social (`leads-quentes-informar.mjs`, 21/10/2026; `docs/23-leads-quentes.md`)

- O robô em si **não é um script**: é a tarefa agendada `leads-quentes-ensino-social` do aplicativo Claude (seg–sex, 9h–17h,
  a cada 2 h), que abre o Chrome do Rammer, opera a fila do admin do Ensino Social e manda WhatsApp pelo 6052. Procedimento
  e regras em `~/Documents/Matriz Ensino Nacional/Leads quentes Ensino Social/CLAUDE.md`. Só roda com o app Claude aberto.
- Este script é a ponte com o painel: `node robo/leads-quentes-informar.mjs --estado` (modo, pausa, última rodada; o robô lê
  antes de agir) e `node robo/leads-quentes-informar.mjs '<json>'` (devolve a rodada e o que fez com cada pessoa). Tela:
  `/leads-quentes` (controles "Liberar envios" e "Pausar"). Mesmo token da revisão.

## Fila do IndexNow (`indexnow.mjs`, 15/10/2026; `docs/22-indexnow-bing.md`)

- O Worker avisa o Bing (IndexNow) de cada URL nova do feed, mas o Bing devolve 429 ao IP compartilhado da Cloudflare.
  O que não entrou fica em `config` (`indexnow_fila_<id>`); este script, a cada 30 min (launchd), lê `GET /api/indexnow/fila`,
  manda ao Bing do IP do Mac e baixa a fila (`POST /api/indexnow/fila`).
- Log: `~/Library/Logs/metricas-indexnow.log`. Na mão: `node robo/indexnow.mjs`.
- Instalar/recarregar: `cp robo/br.com.metricas.indexnow.plist ~/Library/LaunchAgents/ && launchctl bootout gui/$(id -u)/br.com.metricas.indexnow 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/br.com.metricas.indexnow.plist`.
