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
  const scored = scoreClusters(clusters);

  return { rawCount: githubItems.length + hnItems.length, clusters: scored };
}
