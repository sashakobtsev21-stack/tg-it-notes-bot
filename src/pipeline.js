// Скоринг теперь тоже дёргает Gemini (оценка интересности) — .env должен
// быть загружен здесь, а не только в draft.js/review.js, иначе select.js
// (который сам dotenv не грузит) молча упадёт на "GEMINI_API_KEY не задан".
import "dotenv/config";
import { githubRepos, hnKeywords } from "./config/sources.js";
import { fetchAllGithubReleases } from "./collectors/githubReleases.js";
import { fetchHackerNews } from "./collectors/hn.js";
import { clusterItems } from "./dedup.js";
import { scoreClusters, rescoreWithBody } from "./score.js";
import { fetchArticleBody } from "./collectors/articleBody.js";

// Сколько верхних HN-тем без текста источника обогащать статьёй за прогон.
// Дорого фетчить веб-страницы всем подряд (100+ HN-тем в сутки) — но
// топ-кандидатам по первому проходу скоринга, которым нечем зацепиться за
// интересность, стоит.
const ENRICH_TOP_N = 10;

// Общий сбор -> дедуп -> скоринг -> обогащение для select.js и draft.js,
// чтобы не держать одну и ту же последовательность в двух местах.
export async function runPipeline() {
  const [githubItems, hnItems] = await Promise.all([
    fetchAllGithubReleases(githubRepos),
    fetchHackerNews(hnKeywords),
  ]);

  const clusters = clusterItems([...githubItems, ...hnItems]);
  const scored = await scoreClusters(clusters);

  const toEnrich = scored
    .filter((c) => !c.body && c.sources.includes("hackernews"))
    .slice(0, ENRICH_TOP_N);

  for (const cluster of toEnrich) {
    try {
      const { text, imageUrl } = await fetchArticleBody(cluster.url);
      const rescored = await rescoreWithBody(cluster, text, imageUrl);
      scored[scored.indexOf(cluster)] = rescored;
    } catch (err) {
      console.error(`[pipeline] не вытащил текст статьи ${cluster.url}: ${err.message}`);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return { rawCount: githubItems.length + hnItems.length, clusters: scored };
}
