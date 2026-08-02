// Скоринг теперь тоже дёргает Gemini (оценка интересности) — .env должен
// быть загружен здесь, а не только в draft.js/review.js, иначе select.js
// (который сам dotenv не грузит) молча упадёт на "GEMINI_API_KEY не задан".
import "dotenv/config";
import { githubRepos, hnKeywords } from "./config/sources.js";
import { fetchAllGithubReleases } from "./collectors/githubReleases.js";
import { fetchHackerNews } from "./collectors/hn.js";
import { clusterItems } from "./dedup.js";
import { scoreClusters } from "./score.js";

// Общий сбор -> дедуп -> скоринг для select.js и draft.js, чтобы не
// держать одну и ту же последовательность в двух местах.
export async function runPipeline() {
  const [githubItems, hnItems] = await Promise.all([
    fetchAllGithubReleases(githubRepos),
    fetchHackerNews(hnKeywords),
  ]);

  const clusters = clusterItems([...githubItems, ...hnItems]);
  const scored = await scoreClusters(clusters);

  return { rawCount: githubItems.length + hnItems.length, clusters: scored };
}
