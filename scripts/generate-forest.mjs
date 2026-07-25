#!/usr/bin/env node
/**
 * generate-forest.mjs (v3 — floresta viva)
 * ---------------------------------------------------------------------------
 * v2 + três extensões:
 *   1. Copas compartilhadas entre árvores vizinhas (mesmo dia da semana,
 *      semanas consecutivas, ambas com contribuição) — efeito de floresta
 *      contínua em vez de árvores isoladas.
 *   2. Elementos raros por marco:
 *        - cerejeira a cada 100 contribuições acumuladas no ano
 *        - tucano em dias de contribuição muito alta (>= 10)
 *        - borboleta em dias esparsos (determinístico, não aleatório de verdade)
 *        - cogumelo em dias de baixa atividade (esparso)
 *        - vitória-régia no único dia de PICO de contribuições do ano
 *   3. Suporte a múltiplos temas de sprite (ex.: "amazonia", "gbc"), trocando
 *      só o parâmetro --theme, sem mexer no código.
 *
 * Uso:
 *   GITHUB_TOKEN=xxx node generate-forest.mjs <username> <output.svg> [tema]
 * ---------------------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , usernameArg, outputArg, themeArg] = process.argv;
const username = usernameArg || process.env.GITHUB_USER_NAME;
const outputPath = outputArg || "forest-contribution-grid.svg";
const theme = themeArg || "amazonia";
const token = process.env.GITHUB_TOKEN;

if (!username) {
  console.error("Uso: node generate-forest.mjs <username> <output.svg> [tema]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Carregar tileset principal (5 níveis) + tileset de elementos especiais
// ---------------------------------------------------------------------------
function loadTileset(dir) {
  const palette = JSON.parse(fs.readFileSync(path.join(dir, "palette.json"), "utf-8"));
  const sprites = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".txt")) continue;
    const name = file.replace(".txt", "");
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    const rows = raw.replace(/\r/g, "").split("\n").filter((r) => r.length > 0);
    sprites[name] = rows;
  }
  return { palette, sprites };
}

const themeDir = path.join(__dirname, "sprites", theme);
const mainTileset = loadTileset(themeDir);

const specialDir = path.join(themeDir, "special");
const specialTileset = fs.existsSync(specialDir) ? loadTileset(specialDir) : null;

const SPRITE_W = mainTileset.sprites.level0[0].length;
const SPRITE_H = mainTileset.sprites.level0.length;
const PIXEL = 2;
const AVATAR_PIXEL = 3; // avatar é desenhado maior que as árvores, pra ficar detalhado
const CELL = SPRITE_W * PIXEL + 4;
const MARGIN_LEFT = 30;
const MARGIN_TOP = 20;

// ---------------------------------------------------------------------------
// 2. Buscar dados reais via GraphQL (com fallback para dados de exemplo)
// ---------------------------------------------------------------------------
async function fetchContributions(user) {
  if (!token) {
    console.warn("Sem GITHUB_TOKEN — usando dados de exemplo para teste local.");
    return generateSampleWeeks();
  }

  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
                weekday
              }
            }
          }
        }
      }
    }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: user } }),
  });

  if (!res.ok) throw new Error(`GitHub GraphQL API retornou ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (json.errors) throw new Error("Erro GraphQL: " + JSON.stringify(json.errors));

  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

function generateSampleWeeks() {
  const weeks = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 7 * 52);
  start.setDate(start.getDate() - start.getDay());

  let cursor = new Date(start);
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const isFuture = cursor > today;
      const count = isFuture ? 0 : Math.floor(Math.random() * Math.random() * 15);
      days.push({ date: cursor.toISOString().slice(0, 10), contributionCount: count, weekday: d });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push({ contributionDays: days });
  }
  return weeks;
}

function levelFromCount(count) {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

// Hash determinístico simples a partir de uma string (data), 0-99.
// Usado para decidir elementos esparsos (borboleta, cogumelo) sem depender
// de aleatoriedade real — assim a imagem é reprodutível a cada geração,
// mudando só quando novos dias de contribuição entram no calendário.
function hashDate(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) {
    h = (h * 31 + dateStr.charCodeAt(i)) % 9973;
  }
  return h % 100;
}

// ---------------------------------------------------------------------------
// 3. Desenhar um sprite (grid de caracteres) como retângulos pixel-art
// ---------------------------------------------------------------------------
function spriteToRects(rows, palette, cx, cy, animation = null, pixelSize = PIXEL) {
  const w = rows[0].length;
  const h = rows.length;
  const originX = cx - (w * pixelSize) / 2;
  const originY = cy - (h * pixelSize) / 2;

  let pixels = "";
  for (let y = 0; y < h; y++) {
    const row = rows[y] || "";
    for (let x = 0; x < w; x++) {
      const ch = row[x] || ".";
      const color = palette[ch];
      if (!color) continue;
      const px = originX + x * pixelSize;
      const py = originY + y * pixelSize;
      pixels += `<rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pixelSize}" height="${pixelSize}" fill="${color}" />`;
    }
  }

  if (!animation) return pixels;

  // Envolve o sprite num <g> com SMIL <animateTransform> — mesma técnica
  // usada pela cobrinha (Platane/snk), comprovadamente confiável em todo
  // visualizador de SVG: se a animação não rodar, o <g> continua visível
  // na posição base (transform inicial), nunca "preso invisível".
  if (animation === "flutter") {
    // Borboleta: sobe e desce suavemente, com leve deriva lateral
    return `<g>${pixels}
      <animateTransform attributeName="transform" type="translate"
        values="0,0; 1,-1.5; -0.5,-2.5; 0.5,-1; 0,0"
        keyTimes="0; 0.25; 0.5; 0.75; 1"
        dur="2.4s" repeatCount="indefinite" calcMode="spline"
        keySplines="0.4 0 0.6 1; 0.4 0 0.6 1; 0.4 0 0.6 1; 0.4 0 0.6 1" />
    </g>`;
  }

  if (animation === "wobble") {
    // Tucano: pequeno balanço, como se movesse a cabeça
    return `<g>${pixels}
      <animateTransform attributeName="transform" type="rotate"
        values="0 ${cx} ${cy}; 4 ${cx} ${cy}; 0 ${cx} ${cy}; -4 ${cx} ${cy}; 0 ${cx} ${cy}"
        dur="1.8s" repeatCount="indefinite" />
    </g>`;
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// 4. Montar o SVG completo
// ---------------------------------------------------------------------------
function buildSVG(weeks) {
  const numWeeks = weeks.length;
  const AVATAR_LANE = specialTileset && specialTileset.sprites.walk_1 ? 18 * AVATAR_PIXEL + 10 : 0;
  const width = MARGIN_LEFT + numWeeks * CELL + 10;
  const height = MARGIN_TOP + 7 * CELL + 10 + AVATAR_LANE;

  // Achata em ordem cronológica para: (a) achar o dia de pico global,
  // (b) calcular acumulado para as cerejeiras a cada 100.
  const flat = [];
  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => flat.push({ ...day, weekIndex: wi }));
  });
  flat.sort((a, b) => new Date(a.date) - new Date(b.date));

  const peakDay = flat.reduce((max, d) => (d.contributionCount > (max?.contributionCount ?? -1) ? d : max), null);

  let cumulative = 0;
  let lastCherryMilestone = 0;
  const cherryDates = new Set();
  flat.forEach((d) => {
    cumulative += d.contributionCount;
    const milestone = Math.floor(cumulative / 100);
    if (milestone > lastCherryMilestone) {
      cherryDates.add(d.date);
      lastCherryMilestone = milestone;
    }
  });

  // Índice rápido: bioma[weekIndex][weekday] -> dia
  const grid = {};
  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      grid[`${wi}-${day.weekday}`] = day;
    });
  });

  let shapes = "";
  let bridges = "";
  let totalContrib = 0;
  let daysWithContrib = 0;

  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      const level = levelFromCount(day.contributionCount);
      totalContrib += day.contributionCount;
      if (day.contributionCount > 0) daysWithContrib++;

      const cx = MARGIN_LEFT + wi * CELL + CELL / 2;
      const cy = MARGIN_TOP + day.weekday * CELL + CELL / 2;

      // --- Extensão 1: copa compartilhada com o vizinho da semana seguinte
      // (mesmo dia da semana, ambos com contribuição) ---
      const neighbor = grid[`${wi + 1}-${day.weekday}`];
      if (level > 0 && neighbor && neighbor.contributionCount > 0) {
        const nx = MARGIN_LEFT + (wi + 1) * CELL + CELL / 2;
        const bridgeY = cy - PIXEL * 1.5; // altura aproximada da copa
        const bridgeColor = mainTileset.palette.L || mainTileset.palette.B;
        bridges += `<rect x="${(cx).toFixed(1)}" y="${bridgeY.toFixed(1)}" width="${(nx - cx).toFixed(1)}" height="${(PIXEL * 1.5).toFixed(1)}" fill="${bridgeColor}" opacity="0.55" />`;
      }

      // --- Extensão 2: elementos raros (sobrepostos à árvore normal) ---
      let specialDrawn = false;
      if (specialTileset) {
        const { sprites: sp, palette: spPal } = specialTileset;

        if (peakDay && day.date === peakDay.date && day.contributionCount > 0 && sp.victoria) {
          shapes += spriteToRects(sp.victoria, spPal, cx, cy);
          specialDrawn = true;
        } else if (cherryDates.has(day.date) && sp.cherry) {
          shapes += spriteToRects(sp.cherry, spPal, cx, cy);
          specialDrawn = true;
        } else if (day.contributionCount >= 10 && sp.toucan) {
          shapes += spriteToRects(sp.toucan, spPal, cx, cy, "wobble");
          specialDrawn = true;
        } else if (
          day.contributionCount >= 3 &&
          day.contributionCount <= 5 &&
          hashDate(day.date) < 4 &&
          sp.butterfly
        ) {
          shapes += spriteToRects(sp.butterfly, spPal, cx, cy, "flutter");
          specialDrawn = true;
        } else if (
          day.contributionCount >= 1 &&
          day.contributionCount <= 2 &&
          hashDate(day.date) >= 96 &&
          sp.mushroom
        ) {
          shapes += spriteToRects(sp.mushroom, spPal, cx, cy);
          specialDrawn = true;
        }
      }

      if (!specialDrawn) {
        const levelRows = mainTileset.sprites[`level${level}`];
        shapes += spriteToRects(levelRows, mainTileset.palette, cx, cy);
      }
    });
  });

  console.log(
    `[diagnóstico] tema=${theme} semanas=${weeks.length} total_contribuicoes=${totalContrib} dias_com_contribuicao=${daysWithContrib} pico=${peakDay?.date}(${peakDay?.contributionCount}) cerejeiras=${cherryDates.size}`
  );

  // --- Avatar caminhando: sobreposto a todo o grid, não amarrado a um dia
  // específico. Anda da esquerda para a direita e volta, em loop, na "linha
  // do chão" logo abaixo da última linha do calendário (sábado). ---
  let avatarLayer = "";
  if (specialTileset && specialTileset.sprites.walk_1 && specialTileset.sprites.walk_2) {
    const avatarY = MARGIN_TOP + 7 * CELL + (18 * AVATAR_PIXEL) / 2 + 10;
    const ax = MARGIN_LEFT + 20;
    const frame1 = spriteToRects(specialTileset.sprites.walk_1, specialTileset.palette, ax, avatarY, null, AVATAR_PIXEL);
    const frame2 = spriteToRects(specialTileset.sprites.walk_2, specialTileset.palette, ax, avatarY, null, AVATAR_PIXEL);
    const walkDistance = numWeeks * CELL - CELL - 40;
    const stepDur = 0.6; // segundos por passo — mais rápido que o percurso inteiro

    // Cada quadro fica dentro do mesmo <g> que caminha (garante que os dois
    // sigam juntos); a alternância de visibilidade entre os dois cria o
    // "ciclo de passos", igual a um sprite sheet de Game Boy.
    avatarLayer = `<g>
      <animateTransform attributeName="transform" type="translate"
        values="0,0; ${walkDistance.toFixed(1)},0; 0,0"
        keyTimes="0; 0.5; 1"
        dur="24s" repeatCount="indefinite" calcMode="linear" />
      <g visibility="visible">
        ${frame1}
        <animate attributeName="visibility" values="visible;hidden;visible" keyTimes="0;0.5;1" dur="${stepDur}s" repeatCount="indefinite" />
      </g>
      <g visibility="hidden">
        ${frame2}
        <animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;0.5;1" dur="${stepDur}s" repeatCount="indefinite" />
      </g>
    </g>`;
  }

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="none" />
  ${bridges}
  ${shapes}
  ${avatarLayer}
</svg>`;
}

// ---------------------------------------------------------------------------
// 5. Executar
// ---------------------------------------------------------------------------
const weeks = await fetchContributions(username);
const svg = buildSVG(weeks);
fs.writeFileSync(outputPath, svg, "utf-8");
console.log(`SVG gerado: ${outputPath} (tema: ${theme}, ${weeks.length} semanas)`);
