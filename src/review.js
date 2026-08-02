import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { pickDraftableClusters, draftForCluster } from "./draft.js";
import { sendReviewMessage, waitForDecision } from "./telegram/bot.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
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

  // Публикация (task 5) и обработка свободного текста правки — ещё не
  // подключены. Пока review.js только доказывает, что решение долетает
  // и распознаётся правильно.
  if (action === "pub") {
    console.log(`-> ПУБЛИКУЙ: "${cluster.title}" (публикация в канал — следующий шаг, пока не подключена)\n`);
  } else if (action === "edit") {
    console.log(`-> ПРАВЬ: "${cluster.title}" (приём свободного текста правки — следующий шаг)\n`);
  } else if (action === "rej") {
    console.log(`-> ОТКЛОНЕНО: "${cluster.title}"\n`);
  } else {
    console.log(`-> нет ответа за 10 минут, пропускаю: "${cluster.title}"\n`);
  }
}
