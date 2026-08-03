// Скоринг по формуле из разбора: Format/Novelty/Confidence/Velocity с весами,
// умноженные на давность. v1 — правило-скоринг, без LLM и без ключей (осознанно:
// та же логика, что уже работает на сети сайтов — дешёвый слой впереди дорогого).
//
// Упрощения этой версии, которые стоит знать:
// - Velocity считается только по очкам HN — нет ещё поллинга звёзд GitHub
//   во времени, так что у github-releases элементов velocity всегда 0.
// - Recency-множитель один на всех (полураспад 24ч), в разборе предполагалась
//   разная скорость затухания по категориям — можно уточнить позже на реальных
//   данных, сейчас это додумывание вслепую.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { significantWords, jaccard } from "./dedup.js";
import { generateJSON } from "./llm/gemini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED_ARCHIVE = path.join(__dirname, "..", "data", "published.json");

const WEIGHTS = { format: 0.35, novelty: 0.25, confidence: 0.25, velocity: 0.15 };

// Порядок важен — первое совпадение побеждает.
const FORMAT_RULES = [
  {
    pattern: /\bday\s?\d\b|\bkeynote\b|\blive\s?(blog|from|update)\b/i,
    label: "live-event",
    score: 0,
    hardBlock: true,
  },
  { pattern: /\bshow hn\b|\bask hn\b/i, label: "hn-meta", score: 2 },
  {
    pattern: /\bvs\.?\b|\bversus\b|\bbeats\b|\boutperforms\b|\bsurpasses\b|\bbetter than\b/i,
    label: "conflict",
    score: 9,
  },
  {
    pattern: /\bfree\b|\bopen[\s-]?source\b|\bopen[\s-]?weight\b/i,
    label: "free-tool",
    score: 8,
  },
  {
    pattern: /\brelease[sd]?\b|\bannounc(es|ing|ed)\b|\bintroduc(es|ing|ed)\b|\blaunch(es|ed)?\b/i,
    label: "release",
    score: 7,
  },
];
const DEFAULT_FORMAT = { label: "generic", score: 5 };

// Некоторые репозитории (например llama.cpp) тегируют релизом почти каждую
// сборку — заголовок после "owner/repo: " оказывается голым номером/кодом
// без единого содержательного слова. Это не новость, это шум CI.
function isBuildTagNoise(title) {
  const afterPrefix = title.replace(/^[\w.-]+\/[\w.-]+:\s*/, "").trim();
  return /^[a-z]{0,3}\.?-?\d[\d.\-]*$/i.test(afterPrefix);
}

function scoreFormat(title) {
  if (isBuildTagNoise(title)) {
    return { label: "build-tag-noise", score: 0, hardBlock: true };
  }
  return FORMAT_RULES.find((rule) => rule.pattern.test(title)) ?? DEFAULT_FORMAT;
}

const INTEREST_SYSTEM = `Ты оцениваешь новости для Telegram-канала IT/ИИ (аудитория —
русскоязычные разработчики И обычные пользователи, интересующиеся технологиями:
релизы нейросетей, IT-инструменты, кибербезопасность, гаджеты — не только
узкие специалисты).

Хорошо заходит: конфликт двух известных продуктов, значимая новая
возможность или бенчмарк, бесплатный инструмент под конкретную задачу,
неожиданный факт — и то, что можно объяснить понятно человеку без
специальных знаний в узкой области.
Плохо заходит: рутинный патч-релиз (баг-фиксы, bump версий зависимостей,
внутренний рефакторинг без эффекта для пользователя), техническая мелочь,
интересная только узкому кругу контрибьюторов репозитория. Замер 02.08:
"Rust-замена Spark" — реальная и не рутинная новость, но настолько
нишевая (специфика конкретного инфраструктурного стека), что читателю
без бэкграунда в data engineering в принципе непонятна — тоже плохо заходит,
даже если формально не патч.

Оцени тему от 0 (совсем не интересно или непонятно широкой аудитории) до
10 (обязательно достойно поста и понятно не только специалистам).`;

const INTEREST_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    reason: { type: "string", description: "одно короткое предложение по-русски" },
  },
  required: ["score", "reason"],
};

// Ключевой замер (02.08): по ключевым словам в заголовке "langchain-core==1.5.2"
// и "v0.120.1" неотличимы от значимого релиза — 62 темы с текстом источника
// в watch-листе, и почти все рутинные патчи проходили как "generic". Заменяем
// суждением модели, которая читает текст источника, а не только заголовок.
// Гейтится в scoreCluster: только если тему не убил дешёвый regex-блок и она
// не настолько старая, что всё равно умрёт от recency (не тратим вызовы зря).
async function classifyInterest(cluster) {
  try {
    const { score, reason } = await generateJSON({
      system: INTEREST_SYSTEM,
      user: `Заголовок: ${cluster.title}\nТекст источника:\n${cluster.body.slice(0, 1000)}`,
      schema: INTEREST_SCHEMA,
    });
    const clamped = Math.max(0, Math.min(10, Number(score) || 0));
    return { label: `llm-interest: ${reason}`, score: clamped };
  } catch (err) {
    // LLM недоступен — не роняем весь скоринг, откатываемся на дешёвые правила.
    console.error(`[score] classifyInterest упал, откат на regex: ${err.message}`);
    return null;
  }
}

function loadPublishedArchive() {
  if (!existsSync(PUBLISHED_ARCHIVE)) return [];
  return JSON.parse(readFileSync(PUBLISHED_ARCHIVE, "utf8"));
}

// 10, если тема ни на что похожая не публиковалась; 0 (жёсткий отбой), если
// похожа на уже опубликованное на ≥0.85. Пока архив пуст — все темы новые.
function scoreNovelty(words, published) {
  if (published.length === 0) return 10;
  let maxSim = 0;
  for (const p of published) {
    const sim = jaccard(words, significantWords(p.title));
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim >= 0.85 ? 0 : Math.round((1 - maxSim) * 10);
}

function scoreConfidence(cluster) {
  if (cluster.sources.includes("github-releases")) return 10;
  if (cluster.sourceCount >= 2) return 7;
  return 4;
}

function scoreVelocity(cluster) {
  const maxPoints = cluster.items.reduce((max, i) => Math.max(max, i.points ?? 0), 0);
  return Math.min(10, Math.round((maxPoints / 200) * 10));
}

function recencyMultiplier(firstSeenAt, halfLifeHours = 24) {
  const ageHours = (Date.now() - new Date(firstSeenAt).getTime()) / 3_600_000;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

// Ниже этого recency LLM-оценку интересности уже не спрашиваем — итоговый
// счёт всё равно упадёт ниже порога отбоя, вызов модели был бы впустую.
const INTEREST_CHECK_RECENCY_FLOOR = 0.1;

// Замер 02.08: подряд без пауз упёрлись в 429 бесплатного тарифа (quotaValue
// 20) уже на 8-м вызове за прогон — retry в gemini.js не спасает, если лимит
// ещё не сбросился. Пауза перед КАЖДЫМ вызовом дешевле, чем откат на regex
// для половины тем.
const INTEREST_CALL_DELAY_MS = 3500;

export async function scoreCluster(cluster, published) {
  const words = significantWords(cluster.title);
  let format = scoreFormat(cluster.title);
  const novelty = scoreNovelty(words, published);
  const confidence = scoreConfidence(cluster);
  const velocity = scoreVelocity(cluster);
  const recency = recencyMultiplier(cluster.firstSeenAt);

  if (!format.hardBlock && cluster.body && recency > INTEREST_CHECK_RECENCY_FLOOR) {
    await new Promise((r) => setTimeout(r, INTEREST_CALL_DELAY_MS));
    const interest = await classifyInterest(cluster);
    if (interest) format = interest;
  }

  const raw =
    WEIGHTS.format * format.score +
    WEIGHTS.novelty * novelty +
    WEIGHTS.confidence * confidence +
    WEIGHTS.velocity * velocity;

  const score = format.hardBlock ? 0 : Math.round(raw * recency * 10) / 10;

  return {
    ...cluster,
    score,
    breakdown: {
      format: format.label,
      formatScore: format.score,
      novelty,
      confidence,
      velocity,
      recency: Math.round(recency * 100) / 100,
    },
  };
}

// Последовательно, не Promise.all — не знаем точный RPM-лимит бесплатного
// тарифа gemini-flash-latest, безопаснее не бить пачкой одновременных вызовов.
export async function scoreClusters(clusters) {
  const published = loadPublishedArchive();
  const scored = [];
  for (const cluster of clusters) {
    scored.push(await scoreCluster(cluster, published));
  }
  return scored.sort((a, b) => b.score - a.score);
}

// Для pipeline.js: пересчитать одну тему после того, как ей отдельно
// подтянули текст статьи + картинку (HN-обогащение) — не тащить наружу
// loadPublishedArchive ради одного вызова.
export async function rescoreWithBody(cluster, body, imageUrl = cluster.imageUrl) {
  const published = loadPublishedArchive();
  return scoreCluster({ ...cluster, body, imageUrl }, published);
}

export function bucketOf(score) {
  if (score >= 7.5) return "авто-очередь";
  if (score >= 5) return "на подтверждение";
  return "отбой";
}
