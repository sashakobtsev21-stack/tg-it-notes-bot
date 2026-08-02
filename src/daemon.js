// Долгоживущий процесс: слушает личку с ботом, по триггерному слову
// запускает runReviewBatch(), потом снова слушает. Не webhook — тот же
// getUpdates-поллинг, что и весь остальной бот.
//
// Важно понимать про "всегда доступен": процесс живёт, пока запущен этот
// скрипт. Если его запустил я (Claude Code) в рамках сессии — переживёт
// только эту сессию, не дни и не после перезагрузки компьютера. Для
// настоящего "написал в любой момент — и заработало" нужно либо держать
// терминал с этим процессом открытым самостоятельно, либо поставить его
// как настоящую фоновую службу (Планировщик заданий Windows / pm2 и т.п.) —
// это отдельный шаг, не часть этого файла.
import "dotenv/config";
import { runReviewBatch } from "./review.js";
import { waitForTextReply, sendPlainMessage } from "./telegram/bot.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const TRIGGER_WORDS = ["run", "давай", "го", "запускай", "старт", "поехали"];

if (!TOKEN || !CHAT_ID) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_CHAT_ID в .env (см. README).");
  process.exit(1);
}

function isTrigger(text) {
  const normalized = text.trim().toLowerCase();
  return TRIGGER_WORDS.some((w) => normalized.includes(w));
}

console.log("Демон запущен — жду сообщение в Telegram для запуска отбора (Ctrl+C, чтобы остановить).");

// eslint-disable-next-line no-constant-condition
while (true) {
  const text = await waitForTextReply({ token: TOKEN, chatId: CHAT_ID, timeoutMs: 10 * 60 * 1000 });
  if (!text) continue; // просто истёк круг поллинга, ждём дальше

  if (!isTrigger(text)) {
    await sendPlainMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      text: "Не понял — напишите, например, «давай» или «run», чтобы запустить отбор.",
    });
    continue;
  }

  console.log(`Триггер получен: "${text}" — запускаю отбор.`);
  await sendPlainMessage({ token: TOKEN, chatId: CHAT_ID, text: "Запускаю отбор, дайте минуту-другую..." });

  try {
    await runReviewBatch();
  } catch (err) {
    console.error(`Прогон упал: ${err.message}`);
    await sendPlainMessage({ token: TOKEN, chatId: CHAT_ID, text: `Что-то пошло не так: ${err.message}` });
  }
}
