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

export function scoreCluster(cluster, published) {
  const words = significantWords(cluster.title);
  const format = scoreFormat(cluster.title);
  const novelty = scoreNovelty(words, published);
  const confidence = scoreConfidence(cluster);
  const velocity = scoreVelocity(cluster);
  const recency = recencyMultiplier(cluster.firstSeenAt);

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

export function scoreClusters(clusters) {
  const published = loadPublishedArchive();
  return clusters.map((c) => scoreCluster(c, published)).sort((a, b) => b.score - a.score);
}

export function bucketOf(score) {
  if (score >= 7.5) return "авто-очередь";
  if (score >= 5) return "на подтверждение";
  return "отбой";
}
