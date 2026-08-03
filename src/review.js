import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runPipeline } from "./pipeline.js";
import { pickDraftableClusters, draftForCluster, reviseDraft } from "./draft.js";
import { recordPublished } from "./score.js";
import {
  sendReviewMessage,
  waitForDecision,
  waitForTextReply,
  sendPlainMessage,
  publishPost,
  clearKeyboard,
} from "./telegram/bot.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
// Пока это ТЕСТОВЫЙ канал, не боевой @IT_notess. На боевой переключаем
// отдельным явным шагом, не сейчас — см. README.
const PUBLISH_CHAT_ID = process.env.TELEGRAM_TEST_CHANNEL_ID;
const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут на решение, дальше — следующая тема
const MAX_EDIT_ROUNDS = 3; // не бесконечный цикл правок на одну тему

let idCounter = 0;

// Вынесено из тела скрипта в функцию: daemon.js вызывает это по триггеру из
// Telegram в цикле, не запускает процесс заново на каждый раз.
export async function runReviewBatch() {
  if (!TOKEN || !CHAT_ID) {
    throw new Error("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_CHAT_ID в .env (см. README).");
  }

  const { clusters } = await runPipeline();
  const candidates = pickDraftableClusters(clusters);

  if (candidates.length === 0) {
    console.log("Нет тем с текстом источника и score >= 5 прямо сейчас.");
    await sendPlainMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      text: "Прогнал отбор — ничего с достаточным счётом прямо сейчас нет. Попробуйте позже.",
    });
    return;
  }

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

      console.log(`Отправляю на вычитку (круг ${editRound}): ${cluster.title}`);
      const sent = await sendReviewMessage({
        token: TOKEN,
        chatId: CHAT_ID,
        text: draft,
        callbackId,
        photoUrl: cluster.imageUrl,
      });

      const action = await waitForDecision({ token: TOKEN, callbackId, timeoutMs: DECISION_TIMEOUT_MS });

      // Telegram сам кнопки не гасит — они остаются кликабельными, даже
      // когда бот логически уже ждёт другого (текст правки вместо кнопки).
      // Живой баг: клик "Отклони" по старому сообщению после "Правь" молча
      // проглатывался. Снимаем клавиатуру сразу, как только решение принято.
      await clearKeyboard({ token: TOKEN, chatId: CHAT_ID, messageId: sent.result.message_id });

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

        // Молчание в 3-5 секунд, пока думает модель, читается как "бот не
        // получил сообщение" — явное подтверждение закрывает эту дыру.
        await sendPlainMessage({ token: TOKEN, chatId: CHAT_ID, text: "Принял, переписываю..." });

        const revised = await reviseDraft(cluster, draft, instruction).catch((err) => {
          console.error(`Правка не получилась, остаюсь на прошлой версии: ${err.message}`);
          return null;
        });

        if (revised === null) {
          // generateText уже сама пробует запасную модель при квоте — если
          // долетело сюда, обе модели недоступны. Раньше в этом случае молча
          // показывали ту же версию, и владелец не понимал, что она не
          // поменялась — теперь честно говорим.
          await sendPlainMessage({
            token: TOKEN,
            chatId: CHAT_ID,
            text: "Правка не получилась (обе модели недоступны) — версия ниже та же, что была.",
          });
        } else {
          draft = revised;
        }
        editRound++;
        continue;
      }

      finalAction = action;
      break;
    }

    // Каждая ветка ниже раньше писала только в консоль — владелец в Telegram
    // после клика не получал вообще никакого подтверждения, что что-то
    // произошло. Теперь дублируем в чат, не только в лог.
    if (finalAction === "pub") {
      if (!PUBLISH_CHAT_ID) {
        console.log(`-> ПУБЛИКУЙ: "${cluster.title}" — но TELEGRAM_TEST_CHANNEL_ID не задан, не публикую.\n`);
        await sendPlainMessage({
          token: TOKEN,
          chatId: CHAT_ID,
          text: "Нажали «Публикуй», но TELEGRAM_TEST_CHANNEL_ID не задан — не опубликовал.",
        });
        continue;
      }
      await publishPost({ token: TOKEN, chatId: PUBLISH_CHAT_ID, text: draft, photoUrl: cluster.imageUrl });
      // Живой пробел: без этого scoreNovelty сравнивала с вечно пустым
      // архивом, и уже опубликованное всплывало заново на следующем прогоне.
      recordPublished(cluster);
      console.log(`-> ОПУБЛИКОВАНО: "${cluster.title}"\n`);
      await sendPlainMessage({ token: TOKEN, chatId: CHAT_ID, text: "✅ Опубликовано." });
    } else if (finalAction === "rej") {
      console.log(`-> ОТКЛОНЕНО: "${cluster.title}"\n`);
      await sendPlainMessage({ token: TOKEN, chatId: CHAT_ID, text: "❌ Отклонено." });
    } else if (finalAction === "edit") {
      console.log(`-> лимит правок (${MAX_EDIT_ROUNDS}) исчерпан, пропускаю: "${cluster.title}"\n`);
      await sendPlainMessage({
        token: TOKEN,
        chatId: CHAT_ID,
        text: `Правок больше ${MAX_EDIT_ROUNDS} за тему не делаю — публикуйте текущую версию или отклоните.`,
      });
    } else {
      console.log(`-> нет ответа за отведённое время, пропускаю: "${cluster.title}"\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runReviewBatch();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
