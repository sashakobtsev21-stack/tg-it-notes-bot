// Hacker News через официальный бесплатный Algolia Search API — без ключа.
// Документация: https://hn.algolia.com/api

export async function fetchHackerNews(keywords, { hoursBack = 48 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const items = [];

  for (const keyword of keywords) {
    const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
    url.searchParams.set("query", keyword);
    url.searchParams.set("tags", "story");
    url.searchParams.set("numericFilters", `created_at_i>${since}`);

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[hn] "${keyword}": ${res.status}`);
      continue;
    }
    const data = await res.json();
    for (const hit of data.hits ?? []) {
      items.push({
        title: hit.title,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        source: "hackernews",
        matchedKeyword: keyword,
        points: hit.points,
        publishedAt: hit.created_at,
      });
    }
  }

  return items;
}
