import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false });

// Нормализованные элементы {title, url, source, publishedAt} из
// releases.atom одного репозитория.
export async function fetchGithubReleases(repo) {
  const url = `https://github.com/${repo}/releases.atom`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GitHub releases fetch failed for ${repo}: ${res.status}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const entries = parsed?.feed?.entry;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

  return list.map((entry) => ({
    title: `${repo}: ${entry.title}`,
    url: entry.link?.["@_href"] ?? entry.id,
    source: "github-releases",
    sourceRepo: repo,
    publishedAt: entry.updated ?? entry.published,
  }));
}

// Тянет релизы по всем репозиториям параллельно. Падение одного репозитория
// (сеть, редкий репозиторий без releases.atom) не должно ронять весь сбор.
export async function fetchAllGithubReleases(repos) {
  const results = await Promise.allSettled(repos.map(fetchGithubReleases));
  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      items.push(...r.value);
    } else {
      console.error(`[github-releases] ${repos[i]}: ${r.reason.message}`);
    }
  });
  return items;
}
