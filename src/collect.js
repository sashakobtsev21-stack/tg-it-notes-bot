import { githubRepos, hnKeywords } from "./config/sources.js";
import { fetchAllGithubReleases } from "./collectors/githubReleases.js";
import { fetchHackerNews } from "./collectors/hn.js";

const [githubItems, hnItems] = await Promise.all([
  fetchAllGithubReleases(githubRepos),
  fetchHackerNews(hnKeywords),
]);

const all = [...githubItems, ...hnItems].sort(
  (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
);

console.log(
  `Собрано: ${all.length} (GitHub Releases: ${githubItems.length}, HN: ${hnItems.length})\n`
);
for (const item of all) {
  console.log(`[${item.source}] ${item.title}\n  ${item.url}\n  ${item.publishedAt}\n`);
}
