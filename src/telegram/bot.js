// Тонкая обёртка над Telegram Bot API: отправить сообщение с кнопками,
// дождаться, какую нажали. Долгий поллинг (getUpdates), не webhook —
// не нужен хостинг с публичным адресом для этого шага.

const API_BASE = "https://api.telegram.org";

function apiUrl(token, method) {
  return `${API_BASE}/bot${token}/${method}`;
}

export async function sendReviewMessage({ token, chatId, text, callbackId }) {
  const res = await fetch(apiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Публикуй", callback_data: `pub:${callbackId}` },
            { text: "✏️ Правь", callback_data: `edit:${callbackId}` },
            { text: "❌ Отклони", callback_data: `rej:${callbackId}` },
          ],
        ],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Публикация в канал — обычный sendMessage без клавиатуры, chatId — либо
// числовой (-100...), либо "@username" для публичного канала.
export async function publishPost({ token, chatId, text }) {
  const res = await fetch(apiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage (publish) ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// То же самое тело запроса, что publishPost, но семантически другое —
// не публикация в канал, а вопрос владельцу в личку ("что поправить?").
// Не переиспользую publishPost напрямую ради ясности вызывающего кода.
export async function sendPlainMessage({ token, chatId, text }) {
  const res = await fetch(apiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage (plain) ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  await fetch(apiUrl(token, "answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {}); // не критично, если это не пройдёт — просто крутилка на кнопке повисит дольше
}

let updateOffset = null;

// Сливаем всё, что накопилось ДО того, как мы начали ждать — иначе старый
// клик по прошлой кнопке (или сообщение "привет" при первом запуске)
// подхватится как решение по текущей теме.
async function initOffset(token) {
  if (updateOffset !== null) return;
  const res = await fetch(apiUrl(token, "getUpdates") + "?timeout=0");
  const data = await res.json();
  updateOffset = 0;
  for (const u of data.result ?? []) updateOffset = Math.max(updateOffset, u.update_id + 1);
}

// Ждёт нажатие именно на кнопки с этим callbackId. Клики по другим (устаревшим)
// сообщениям гасит явным ответом, чтобы кнопка не крутилась вечно у владельца.
// Возвращает "pub" / "edit" / "rej", или null по таймауту.
export async function waitForDecision({ token, callbackId, timeoutMs = 10 * 60 * 1000 }) {
  await initOffset(token);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const longPollSec = Math.min(30, remainingSec);

    const res = await fetch(
      apiUrl(token, "getUpdates") + `?offset=${updateOffset}&timeout=${longPollSec}`
    );
    const data = await res.json();

    for (const update of data.result ?? []) {
      updateOffset = Math.max(updateOffset, update.update_id + 1);
      const cb = update.callback_query;
      if (!cb) continue;

      const [action, id] = (cb.data ?? "").split(":");
      if (id === callbackId) {
        await answerCallbackQuery(token, cb.id, "Принято");
        return action;
      }
      await answerCallbackQuery(token, cb.id, "Это уже неактуально");
    }
  }

  return null;
}

// Ждёт обычное текстовое сообщение (не клик по кнопке) от владельца — приём
// свободной инструкции после "Правь". Тот же offset, что у waitForDecision
// (общий на модуль) — иначе один и тот же апдейт можно перечитать дважды за
// один прогон. Случайный клик по кнопке в это время — не ошибка, а нормальный
// сценарий (передумал/промахнулся): гасим явным ответом, чтобы не висела
// вечная крутилка, и ждём дальше именно текст.
export async function waitForTextReply({ token, chatId, timeoutMs = 10 * 60 * 1000 }) {
  await initOffset(token);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const longPollSec = Math.min(30, remainingSec);

    const res = await fetch(
      apiUrl(token, "getUpdates") + `?offset=${updateOffset}&timeout=${longPollSec}`
    );
    const data = await res.json();

    for (const update of data.result ?? []) {
      updateOffset = Math.max(updateOffset, update.update_id + 1);

      if (update.callback_query) {
        await answerCallbackQuery(token, update.callback_query.id, "Сейчас жду текст правки, не кнопку");
        continue;
      }

      const msg = update.message;
      if (msg && String(msg.chat.id) === String(chatId) && msg.text) {
        return msg.text;
      }
    }
  }

  return null;
}
