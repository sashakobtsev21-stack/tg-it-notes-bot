import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { runPipeline } from "./pipeline.js";
import { generateText } from "./llm/gemini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_POSTS_PATH = path.join(__dirname, "..", "data", "example-posts.md");
const EXAMPLE_DELIMITER = /\n-{3,}\n/;

const CHANNEL_HANDLE = "@IT_notess";
const CANDIDATE_COUNT = 3;

// Формат файла — просто вставленные посты как есть, разделённые строкой
// из трёх (и более) дефисов. Пустой файл — не ошибка, просто пока без
// few-shot (что и было раньше).
function loadExamplePosts() {
  if (!existsSync(EXAMPLE_POSTS_PATH)) return [];
  const raw = readFileSync(EXAMPLE_POSTS_PATH, "utf8").trim();
  if (!raw) return [];
  return raw
    .split(EXAMPLE_DELIMITER)
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildFewShotSection() {
  const examples = loadExamplePosts();
  if (examples.length === 0) return "";
  return (
    "\n\nПримеры реальных постов этого канала — ориентируйся на тон, длину и " +
    "ритм, НЕ копируй структуру дословно (иначе посты станут близнецами):\n\n" +
    examples.map((p, i) => `[Пример ${i + 1}]\n${p}`).join("\n\n")
  );
}

export function buildSystemPrompt() {
  return `Ты пишешь короткие посты для Telegram-канала IT_Notes (аудитория —
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
  рваный ритм читается человечнее.${buildFewShotSection()}`;
}

export function buildUserPrompt(cluster) {
  return `Источник (единственная фактическая база для поста — не выходи за её пределы):

Заголовок: ${cluster.title}
Ссылка: ${cluster.url}
Текст источника:
${cluster.body}

Напиши пост.`;
}

export function buildRevisionPrompt(cluster, previousDraft, instruction) {
  return `Источник (единственная фактическая база для поста — не выходи за её пределы):

Заголовок: ${cluster.title}
Ссылка: ${cluster.url}
Текст источника:
${cluster.body}

Предыдущий черновик:
${previousDraft}

Инструкция от владельца канала, что поправить:
${instruction}

Перепиши пост ЦЕЛИКОМ с учётом инструкции. Это по-прежнему готовый пост для
публикации, не комментарий к правке — все правила формата из системного
промпта остаются в силе (длина, ссылка, финальная строка).`;
}

// Пока черновик пишем только по темам, где есть текст первоисточника —
// без него модели пришлось бы гадать по одному заголовку, а это ровно тот
// риск, от которого весь конвейер должен беречь.
export function pickDraftableClusters(clusters, count = CANDIDATE_COUNT) {
  return clusters.filter((c) => c.score >= 5 && c.body && c.body.length > 50).slice(0, count);
}

// Общая логика для draft.js (просто печатает) и review.js (шлёт в Telegram) —
// на каждый кластер пробуем сгенерировать черновик, ошибка одного не рвёт остальные.
export async function draftForCluster(cluster) {
  return generateText({ system: buildSystemPrompt(), user: buildUserPrompt(cluster) });
}

// Правка по свободной инструкции владельца после "✏️ Правь" в review.js.
export async function reviseDraft(cluster, previousDraft, instruction) {
  return generateText({
    system: buildSystemPrompt(),
    user: buildRevisionPrompt(cluster, previousDraft, instruction),
  });
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
// а не когда draft.js импортируют ради buildSystemPrompt/buildUserPrompt. Без
// process.argv[1] (например, "node -e" с динамическим import()) — точно
// не прямой запуск этого файла, pathToFileURL(undefined) на нём же и упадёт.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
