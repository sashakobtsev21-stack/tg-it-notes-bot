// Дедуп заголовков без внешних API и без ключей: нормализуем в набор значимых
// слов и группируем по пересечению (Jaccard) внутри окна в 48 часов. Это
// грубее, чем эмбеддинги, но бесплатно и достаточно для заголовков новостей.

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "with", "and", "or", "is",
  "are", "as", "by", "at", "from", "this", "that", "it", "its", "be", "how",
  "why", "what", "your", "you", "we", "new", "v", "release", "releases",
  "released", "show", "hn", "ask",
]);

const WINDOW_MS = 48 * 3600 * 1000;
const SIMILARITY_THRESHOLD = 0.5;

export function significantWords(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/^[\w.-]+\/[\w.-]+:\s*/, "") // срезать префикс "owner/repo: " у GitHub-элементов
      .replace(/[^a-z0-9а-яё\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Группирует сырые элементы в темы. Каждая тема несёт representative
// (самый ранний элемент — канонический источник для фактчека), число и
// список независимых источников — это прямые входы для скоринга.
export function clusterItems(items) {
  const clusters = [];

  for (const item of items) {
    const words = significantWords(item.title);
    const publishedMs = new Date(item.publishedAt).getTime();

    const match = clusters.find(
      (c) =>
        Math.abs(c.firstSeenMs - publishedMs) <= WINDOW_MS &&
        jaccard(words, c.words) >= SIMILARITY_THRESHOLD
    );

    if (match) {
      match.items.push(item);
      match.sources.add(item.source);
      if (publishedMs < match.firstSeenMs) {
        match.firstSeenMs = publishedMs;
        match.representative = item;
      }
    } else {
      clusters.push({
        items: [item],
        sources: new Set([item.source]),
        words,
        firstSeenMs: publishedMs,
        representative: item,
      });
    }
  }

  return clusters.map((c) => ({
    title: c.representative.title,
    url: c.representative.url,
    body: c.representative.body ?? "",
    imageUrl: c.representative.imageUrl ?? null,
    firstSeenAt: new Date(c.firstSeenMs).toISOString(),
    sourceCount: c.items.length,
    sources: [...c.sources],
    items: c.items,
  }));
}
