import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runPipeline } from "./pipeline.js";
import { generateText } from "./llm/gemini.js";

const CHANNEL_HANDLE = "@IT_notess";
const CANDIDATE_COUNT = 3;

export const SYSTEM_PROMPT = `Ты пишешь короткие посты для Telegram-канала IT_Notes (аудитория —
русскоязычные разработчики и интересующиеся технологиями: релизы нейросетей,
IT-инструменты, кибербезопасность, гаджеты).

Жёсткие правила формата:
- Длина поста ВСЕГО 150-700 знаков, включая ссылки и финальную строку.
- Разговорный тон, как будто рассказываешь коллеге, а не пресс-релиз.
- Эмодзи в начале ключевых пунктов (не в каждом предложении).
- Обязательно включи в текст поста ссылку из источника как есть (просто сам
  URL, без markdown-разметки) — пост без ссылки не годится, это не опционально.
- Последняя строка ровно: "Подписывайся: ${CHANNEL_HANDLE}"

Что заходит у этой аудитории (пиши с таким прицелом, если применимо к теме):
- конфликт двух известных продуктов ("X обошёл Y")
- бесплатный инструмент под узкую конкретную задачу
- короткий факт с неожиданным поворотом

Что НЕ делать:
- НЕ придумывай факты, цифры, даты — используй только то, что есть в источнике
  ниже. Если чего-то не хватает — не пиши это, а не гадай.
- НЕ используй канцелярит и типовые ИИ-обороты: "в мире технологий", "стоит
  отметить", "нельзя не упомянуть", "это открывает новые возможности",
  вступления вида "недавно стало известно" без конкретики.
- НЕ начинай с общей вводной фразы — сразу конкретный факт или цифра первой
  строкой.
- НЕ пиши симметричные, одинаковые по длине предложения подряд подряд —
  рваный ритм читается человечнее.`;

export function buildUserPrompt(cluster) {
  return `Источник (единственная фактическая база для поста — не выходи за её пределы):

Заголовок: ${cluster.title}
Ссылка: ${cluster.url}
Текст источника:
${cluster.body}

Напиши пост.`;
}

// Пока черновик пишем только по темам, где есть текст первоисточника
// (release notes из GitHub) — без него модели пришлось бы гадать по одному
// заголовку, а это ровно тот риск, от которого весь конвейер должен беречь.
// HN-темы сюда попадут, когда добавим фетч тела статьи по ссылке.
export function pickDraftableClusters(clusters, count = CANDIDATE_COUNT) {
  return clusters.filter((c) => c.score >= 5 && c.body && c.body.length > 50).slice(0, count);
}

// Общая логика для draft.js (просто печатает) и review.js (шлёт в Telegram) —
// на каждый кластер пробуем сгенерировать черновик, ошибка одного не рвёт остальные.
export async function draftForCluster(cluster) {
  const draft = await generateText({ system: SYSTEM_PROMPT, user: buildUserPrompt(cluster) });
  return draft;
}

async function main() {
  const { clusters } = await runPipeline();
  const candidates = pickDraftableClusters(clusters);

  if (candidates.length === 0) {
    console.log("Нет тем с текстом источника и score >= 5 прямо сейчас. Попробуйте позже.");
    return;
  }

  console.log(`Черновики по ${candidates.length} тем(е):\n`);

  for (const cluster of candidates) {
    try {
      const draft = await draftForCluster(cluster);
      console.log(`— ${cluster.title} (score ${cluster.score.toFixed(1)})`);
      console.log(`  источник: ${cluster.url}`);
      console.log(`  длина: ${draft.length} знаков\n`);
      console.log(draft);
      console.log("\n" + "-".repeat(60) + "\n");
    } catch (err) {
      console.error(`Черновик не получился для "${cluster.title}": ${err.message}\n`);
    }
  }
}

// Запускать пайплайн только когда файл выполняется напрямую (npm run draft),
// а не когда draft.js импортируют ради SYSTEM_PROMPT/buildUserPrompt. Без
// process.argv[1] (например, "node -e" с динамическим import()) — точно
// не прямой запуск этого файла, pathToFileURL(undefined) на нём же и упадёт.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
