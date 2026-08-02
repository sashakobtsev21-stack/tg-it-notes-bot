import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { pickDraftableClusters, draftForCluster } from "./draft.js";
import { sendReviewMessage, waitForDecision, publishPost } from "./telegram/bot.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
// Пока это ТЕСТОВЫЙ канал, не боевой @IT_notess. На боевой переключаем
// отдельным явным шагом, не сейчас — см. README.
const PUBLISH_CHAT_ID = process.env.TELEGRAM_TEST_CHANNEL_ID;
const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на тему, дальше — следующая

if (!TOKEN || !CHAT_ID) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_CHAT_ID в .env (см. README).");
  process.exit(1);
}

const { clusters } = await runPipeline();
const candidates = pickDraftableClusters(clusters);

if (candidates.length === 0) {
  console.log("Нет тем с текстом источника и score >= 5 прямо сейчас.");
  process.exit(0);
}

let idCounter = 0;

for (const cluster of candidates) {
  const draft = await draftForCluster(cluster).catch((err) => {
    console.error(`Черновик не получился для "${cluster.title}": ${err.message}`);
    return null;
  });
  if (!draft) continue;

  const callbackId = String(++idCounter);
  const message =
    `${draft}\n\n` + `— score ${cluster.score.toFixed(1)} | источники: ${cluster.sources.join(", ")}`;

  console.log(`Отправляю на вычитку: ${cluster.title}`);
  await sendReviewMessage({ token: TOKEN, chatId: CHAT_ID, text: message, callbackId });

  const action = await waitForDecision({ token: TOKEN, callbackId, timeoutMs: DECISION_TIMEOUT_MS });

  // Обработка свободного текста правки по "Правь" — ещё не подключена.
  if (action === "pub") {
    if (!PUBLISH_CHAT_ID) {
      console.log(`-> ПУБЛИКУЙ: "${cluster.title}" — но TELEGRAM_TEST_CHANNEL_ID не задан, не публикую.\n`);
      continue;
    }
    await publishPost({ token: TOKEN, chatId: PUBLISH_CHAT_ID, text: draft });
    console.log(`-> ОПУБЛИКОВАНО: "${cluster.title}"\n`);
  } else if (action === "edit") {
    console.log(`-> ПРАВЬ: "${cluster.title}" (приём свободного текста правки — следующий шаг)\n`);
  } else if (action === "rej") {
    console.log(`-> ОТКЛОНЕНО: "${cluster.title}"\n`);
  } else {
    console.log(`-> нет ответа за 10 минут, пропускаю: "${cluster.title}"\n`);
  }
}
