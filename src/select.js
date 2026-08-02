import { githubRepos, hnKeywords } from "./config/sources.js";
import { fetchAllGithubReleases } from "./collectors/githubReleases.js";
import { fetchHackerNews } from "./collectors/hn.js";
import { clusterItems } from "./dedup.js";
import { scoreClusters, bucketOf } from "./score.js";

const [githubItems, hnItems] = await Promise.all([
  fetchAllGithubReleases(githubRepos),
  fetchHackerNews(hnKeywords),
]);

const rawCount = githubItems.length + hnItems.length;
const clusters = clusterItems([...githubItems, ...hnItems]);
const scored = scoreClusters(clusters);

console.log(`Собрано ${rawCount} штук -> ${clusters.length} тем после дедупа\n`);

for (const c of scored) {
  console.log(
    `[${c.score.toFixed(1)} | ${bucketOf(c.score)}] ${c.title}\n` +
      `  ${c.url}\n` +
      `  источников: ${c.sourceCount} (${c.sources.join(", ")}) | ` +
      `формат: ${c.breakdown.format} | новизна: ${c.breakdown.novelty} | ` +
      `доверие: ${c.breakdown.confidence} | скорость: ${c.breakdown.velocity} | ` +
      `давность×${c.breakdown.recency}\n`
  );
}
