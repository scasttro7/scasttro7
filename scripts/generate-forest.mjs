#!/usr/bin/env node
/**
 * generate-forest.mjs
 * ---------------------------------------------------------------------------
 * Gera um SVG animado ("floresta brotando") a partir do calendário real de
 * contribuições de um usuário do GitHub, via API GraphQL.
 *
 * Em vez de uma cobra comendo o grid (como Platane/snk), cada quadrado com
 * contribuição vira uma pequena árvore que "brota" em ordem cronológica,
 * com o tamanho da copa proporcional ao nível de contribuição do dia.
 *
 * Uso:
 *   GITHUB_TOKEN=xxx node generate-forest.mjs <username> <output.svg>
 * ---------------------------------------------------------------------------
 */

const [, , usernameArg, outputArg] = process.argv;
const username = usernameArg || process.env.GITHUB_USER_NAME;
const outputPath = outputArg || "forest-contribution-grid.svg";
const token = process.env.GITHUB_TOKEN;

if (!username) {
  console.error("Uso: node generate-forest.mjs <username> <output.svg>");
  process.exit(1);
}

const CELL = 11;        // tamanho de cada célula do grid (px), igual ao GitHub
const GAP = 3;           // espaço entre células
const STEP = CELL + GAP; // passo entre células
const MARGIN_LEFT = 30;  // espaço pros rótulos de dia da semana
const MARGIN_TOP = 20;   // espaço pros rótulos de mês

// Paleta floresta: do "solo" (sem contribuição) ao "dossel denso" (nível 4)
const LEVEL_COLORS = ["#e9e4d8", "#a8d08a", "#6dae52", "#3f7a2f", "#1e3d14"];

// ---------------------------------------------------------------------------
// 1. Buscar dados reais via GraphQL (com fallback para dados de exemplo,
//    usado apenas para testes locais sem token).
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

  if (!res.ok) {
    throw new Error(`GitHub GraphQL API retornou ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error("Erro GraphQL: " + JSON.stringify(json.errors));
  }

  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

// Dados falsos só para eu conseguir testar a geração do SVG sem token real.
function generateSampleWeeks() {
  const weeks = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 7 * 52);
  // alinha ao domingo
  start.setDate(start.getDate() - start.getDay());

  let cursor = new Date(start);
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const isFuture = cursor > today;
      const count = isFuture ? 0 : Math.floor(Math.random() * Math.random() * 12);
      days.push({
        date: cursor.toISOString().slice(0, 10),
        contributionCount: count,
        weekday: d,
      });
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

// ---------------------------------------------------------------------------
// 2. Desenhar uma "árvore" (copa + tronco) escalada pelo nível de contribuição
// ---------------------------------------------------------------------------
function treeShape(cx, cy, level, delaySec, id) {
  if (level === 0) {
    // solo vazio: um pontinho discreto, sem animação
    return `<circle cx="${cx}" cy="${cy}" r="1.2" fill="${LEVEL_COLORS[0]}" />`;
  }

  const scale = 0.55 + level * 0.14; // nivel 1 -> ~0.7 ; nivel 4 -> ~1.11
  const canopyColor = LEVEL_COLORS[level];
  const trunkH = 2.4 * scale;
  const canopyR = 4.2 * scale;

  return `
    <g class="tree" style="animation-delay:${delaySec}s" transform="translate(${cx} ${cy})">
      <rect x="-0.6" y="0" width="1.2" height="${trunkH}" fill="#5a3a1e" />
      <circle cx="0" cy="${-canopyR * 0.4}" r="${canopyR}" fill="${canopyColor}" />
    </g>`;
}

// ---------------------------------------------------------------------------
// 3. Montar o SVG completo
// ---------------------------------------------------------------------------
function buildSVG(weeks) {
  const numWeeks = weeks.length;
  const width = MARGIN_LEFT + numWeeks * STEP + 10;
  const height = MARGIN_TOP + 7 * STEP + 10;

  // Ordena todas as celulas com contribuicao > 0 em ordem cronologica para
  // calcular o atraso de animacao (efeito "brotando ao longo do ano").
  const allDays = [];
  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      allDays.push({ ...day, weekIndex: wi });
    });
  });
  allDays.sort((a, b) => new Date(a.date) - new Date(b.date));

  const totalAnimSeconds = 8; // duracao total do "crescimento" antes de reiniciar
  const daysWithContribution = allDays.filter((d) => d.contributionCount > 0);
  const delayStep = daysWithContribution.length > 0
    ? totalAnimSeconds / daysWithContribution.length
    : 0;

  let delayIndex = 0;
  let shapes = "";

  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      const level = levelFromCount(day.contributionCount);
      const cx = MARGIN_LEFT + wi * STEP + CELL / 2;
      const cy = MARGIN_TOP + day.weekday * STEP + CELL / 2;

      let delaySec = 0;
      if (level > 0) {
        delaySec = delayIndex * delayStep;
        delayIndex++;
      }
      shapes += treeShape(cx, cy, level, delaySec.toFixed(3), `${wi}-${day.weekday}`);
    });
  });

  const loopDuration = totalAnimSeconds + 2; // + pausa antes de reiniciar

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="'Fira Code', monospace">
  <style>
    .tree {
      transform-box: fill-box;
      transform-origin: bottom center;
      opacity: 0;
      animation: sprout ${loopDuration}s ease-out infinite;
    }
    @keyframes sprout {
      0%   { opacity: 0; transform: scale(0); }
      3%   { opacity: 1; transform: scale(1.15); }
      6%   { transform: scale(1); }
      85%  { opacity: 1; transform: scale(1); }
      92%  { opacity: 0; transform: scale(0.85); }
      100% { opacity: 0; transform: scale(0); }
    }
  </style>
  <rect width="100%" height="100%" fill="none" />
  ${shapes}
</svg>`;
}

// ---------------------------------------------------------------------------
// 4. Executar
// ---------------------------------------------------------------------------
const weeks = await fetchContributions(username);
const svg = buildSVG(weeks);

const fs = await import("node:fs");
const path = await import("node:path");

// Garante que a pasta de saída exista
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// Escreve o SVG
fs.writeFileSync(outputPath, svg, "utf-8");

console.log(`SVG gerado: ${outputPath} (${weeks.length} semanas)`);
