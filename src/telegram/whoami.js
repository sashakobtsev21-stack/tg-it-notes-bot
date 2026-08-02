// Разовый помощник: узнать свой chat_id, не заводя стороннего бота вроде
// @userinfobot. Отправьте новому боту любое сообщение в Telegram, потом
// запустите этот скрипт — он прочитает его через getUpdates.
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Сначала впишите TELEGRAM_BOT_TOKEN в .env");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json();

if (!data.ok) {
  console.error("Telegram API вернул ошибку:", data.description);
  process.exit(1);
}

if (!data.result?.length) {
  console.log(
    "Сообщений пока нет. Откройте бота в Telegram (по ссылке, которую дал " +
      "BotFather) и отправьте ему любое сообщение — потом запустите это снова."
  );
  process.exit(0);
}

const last = data.result.at(-1);
const chat = last.message?.chat ?? last.callback_query?.message?.chat;

console.log("Ваш chat_id:", chat?.id);
console.log("Это:", chat?.first_name, chat?.username ? `@${chat.username}` : "");
console.log("\nВпишите это число в .env как TELEGRAM_OWNER_CHAT_ID.");
