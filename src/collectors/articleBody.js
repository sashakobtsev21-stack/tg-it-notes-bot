import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

// jsdom по умолчанию пробрасывает свои предупреждения (не смог распарсить
// CSS, не смог загрузить ресурс и т.п.) в реальную консоль — на живых
// страницах это тысячи строк шума на один фетч. Не нужно: нас интересует
// только результат Readability, а не верное исполнение страницы.
const virtualConsole = new VirtualConsole();

const MAX_BODY_CHARS = 2000;
const FETCH_TIMEOUT_MS = 10_000;

// Вытаскивает читаемый текст статьи + og:image по ссылке (для HN-тем — там
// есть только заголовок, без этого шага черновику не за что зацепиться,
// кроме заголовка). Readability, не голый strip-тегов: обычная веб-страница
// тащит нав/рекламу/подвал вместе с текстом — для GitHub-релизов этого не
// нужно было (releases.atom и так отдаёт только содержимое), а тут без
// разбора разметки в текст источника подмешается мусор, который не факт,
// а вёрстка.
export async function fetchArticleBody(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tg-it-notes-bot/0.1)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`fetch ${url}: ${res.status}`);
  }

  const html = await res.text();
  const dom = new JSDOM(html, { url, virtualConsole });

  const imageUrl = dom.window.document.querySelector('meta[property="og:image"]')?.content || null;

  const article = new Readability(dom.window.document).parse();
  if (!article?.textContent?.trim()) {
    throw new Error("Readability не смог выделить текст статьи");
  }

  return {
    text: article.textContent.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS),
    imageUrl,
  };
}
