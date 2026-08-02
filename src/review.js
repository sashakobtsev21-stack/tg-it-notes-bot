import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { pickDraftableClusters, draftForCluster, reviseDraft } from "./draft.js";
import {
  sendReviewMessage,
  waitForDecision,
  waitForTextReply,
  sendPlainMessage,
  publishPost,
} from "./telegram/bot.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
// Пока это ТЕСТОВЫЙ канал, не боевой @IT_notess. На боевой переключаем
// отдельным явным шагом, не сейчас — см. README.
const PUBLISH_CHAT_ID = process.env.TELEGRAM_TEST_CHANNEL_ID;
const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на решение, дальше — следующая тема
const MAX_EDIT_ROUNDS = 3; // не бесконечный цикл правок на одну тему

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
  let draft = await draftForCluster(cluster).catch((err) => {
    console.error(`Черновик не получился для "${cluster.title}": ${err.message}`);
    return null;
  });
  if (!draft) continue;

  let editRound = 0;
  let finalAction = null;

  // Один и тот же черновик может пройти несколько кругов правки — каждый
  // круг новый callbackId, чтобы клик по устаревшему сообщению не спутался
  // с текущим (waitForDecision это уже умеет различать).
  while (true) {
    const callbackId = String(++idCounter);
    const message =
      `${draft}\n\n` + `— score ${cluster.score.toFixed(1)} | источники: ${cluster.sources.join(", ")}`;

    console.log(`Отправляю на вычитку (круг ${editRound}): ${cluster.title}`);
    await sendReviewMessage({ token: TOKEN, chatId: CHAT_ID, text: message, callbackId });

    const action = await waitForDecision({ token: TOKEN, callbackId, timeoutMs: DECISION_TIMEOUT_MS });

    if (action === "edit" && editRound < MAX_EDIT_ROUNDS) {
      await sendPlainMessage({
        token: TOKEN,
        chatId: CHAT_ID,
        text: "Напишите текстом, что поправить — перепишу и пришлю снова.",
      });

      const instruction = await waitForTextReply({ token: TOKEN, chatId: CHAT_ID, timeoutMs: DECISION_TIMEOUT_MS });

      if (!instruction) {
        finalAction = null; // таймаут на саму инструкцию
        break;
      }

      draft = await reviseDraft(cluster, draft, instruction).catch((err) => {
        console.error(`Правка не получилась, остаюсь на прошлой версии: ${err.message}`);
        return draft;
      });
      editRound++;
      continue;
    }

    finalAction = action;
    break;
  }

  if (finalAction === "pub") {
    if (!PUBLISH_CHAT_ID) {
      console.log(`-> ПУБЛИКУЙ: "${cluster.title}" — но TELEGRAM_TEST_CHANNEL_ID не задан, не публикую.\n`);
      continue;
    }
    await publishPost({ token: TOKEN, chatId: PUBLISH_CHAT_ID, text: draft });
    console.log(`-> ОПУБЛИКОВАНО: "${cluster.title}"\n`);
  } else if (finalAction === "rej") {
    console.log(`-> ОТКЛОНЕНО: "${cluster.title}"\n`);
  } else if (finalAction === "edit") {
    console.log(`-> лимит правок (${MAX_EDIT_ROUNDS}) исчерпан, пропускаю: "${cluster.title}"\n`);
  } else {
    console.log(`-> нет ответа за отведённое время, пропускаю: "${cluster.title}"\n`);
  }
}
