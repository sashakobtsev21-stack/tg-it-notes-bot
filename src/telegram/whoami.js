// Разовый помощник: узнать chat_id — свой личный или тестового канала — не
// заводя сторонних ботов вроде @userinfobot. Для личного chat_id: отправьте
// боту любое сообщение. Для канала: сделайте бота админом с правом Post
// Messages и отправьте в канал любой пост. Потом запустите этот скрипт.
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
    "Обновлений пока нет. Отправьте боту личное сообщение (для своего chat_id) " +
      "или пост в канал, где бот админ (для chat_id канала) — потом запустите это снова."
  );
  process.exit(0);
}

console.log(`Найдено обновлений: ${data.result.length}. Последние (до 5):\n`);

for (const update of data.result.slice(-5)) {
  const personal = update.message?.chat;
  const channel = update.channel_post?.chat;
  const chat = personal ?? channel;
  if (!chat) continue;

  const kind = channel ? "канал" : "личка";
  console.log(
    `[${kind}] chat_id: ${chat.id}  |  ${chat.title ?? chat.first_name}` +
      (chat.username ? ` (@${chat.username})` : "")
  );
}

console.log(
  "\nЛичный — в TELEGRAM_OWNER_CHAT_ID, канала — в TELEGRAM_TEST_CHANNEL_ID (или PROD, когда дойдём до боевого)."
);
