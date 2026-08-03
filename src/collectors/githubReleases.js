import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false });
const MAX_BODY_CHARS = 2000;

// Атом-фид отдаёт release notes как HTML в <content>. Черновику нужен
// голый текст — без тегов модель не путает разметку с содержанием.
function stripHtml(html) {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_BODY_CHARS);
}

// Нормализованные элементы {title, url, source, publishedAt, body} из
// releases.atom одного репозитория. body — текст release notes: это и есть
// first_source для черновика, чтобы модель не выдумывала факты.
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
    body: stripHtml(entry.content?.["#text"] ?? entry.content),
    // GitHub сам генерирует соцкарту для каждого репозитория по
    // предсказуемому адресу — не нужен отдельный фетч ради картинки.
    imageUrl: `https://opengraph.githubassets.com/1/${repo}`,
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
