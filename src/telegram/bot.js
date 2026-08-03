// Тонкая обёртка над Telegram Bot API: отправить сообщение с кнопками,
// дождаться, какую нажали. Долгий поллинг (getUpdates), не webhook —
// не нужен хостинг с публичным адресом для этого шага.

const API_BASE = "https://api.telegram.org";

function apiUrl(token, method) {
  return `${API_BASE}/bot${token}/${method}`;
}

// Модель пишет **жирный** (двойная звёздочка, CommonMark) — это то же самое,
// что в примерах постов (они через WebFetch тоже пришли в CommonMark). Но
// Telegram Markdown понимает *жирный* с ОДНОЙ звёздочкой. Без этой замены
// (и без parse_mode вообще, как было раньше) звёздочки просто печатались
// буквально — ровно то, на что владелец пожаловался вживую.
function toTelegramMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// Живой баг: когда Markdown не распарсился (лишняя/непарная звёздочка ГДЕ-ТО
// в тексте роняет разметку целиком у Telegram, не только в месте ошибки) и
// сработал откат ниже — откат слал ИСХОДНЫЙ текст с живыми **/*, и владелец
// увидел пост с буквальными звёздочками вместо жирного. Откат должен чистить
// синтаксис, а не просто снимать parse_mode.
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2");
}

// Голая ссылка в sendMessage заставляет Telegram самому лепить превью-карточку
// (заголовок + описание + картинка страницы) — это НЕ то, что мы просим, это
// побочный эффект. Живая жалоба владельца была как раз на эту карточку.
// photoUrl вместо этого явно шлёт ОДНУ картинку через sendPhoto (caption —
// это и есть текст поста) — превью-карточки при этом не возникает вообще.
// Лимит подписи у Telegram — 1024 знака, длиннее не пробуем, сразу текстом.
const PHOTO_CAPTION_LIMIT = 1024;

// Живой баг: когда своей картинки НЕ было (og:image не нашёлся у источника —
// бывает нестабильно, не всегда есть чем объяснить), падали на голый
// sendMessage — а он БЕЗ явного запрета сам лепит ту же самую нежеланную
// карточку из голой ссылки в тексте (заголовок+описание+картинка страницы).
// Владелец увидел её снова и решил, что фикс с фото не сработал вообще.
// link_preview_options.is_disabled глушит это на всех путях без своего фото.
function withNoPreview(body) {
  return { ...body, link_preview_options: { is_disabled: true } };
}

// Telegram 400-ит, если разметка кривая (несовпавшая звёздочка) или сама
// картинка недоступна ему (мёртвый og:image, редкий случай) — такое реально
// бывает у сгенерированного текста и у чужих страниц. Один откат на голый
// sendMessage без parse_mode и без фото: сообщение всё равно уходит.
async function sendMessageRaw({ token, chatId, text, photoUrl, replyMarkup }) {
  const usePhoto = Boolean(photoUrl) && text.length <= PHOTO_CAPTION_LIMIT;
  const method = usePhoto ? "sendPhoto" : "sendMessage";
  const textField = usePhoto ? "caption" : "text";

  let body = { chat_id: chatId, parse_mode: "Markdown" };
  body[textField] = toTelegramMarkdown(text);
  if (usePhoto) body.photo = photoUrl;
  else body = withNoPreview(body);
  if (replyMarkup) body.reply_markup = replyMarkup;

  let res = await fetch(apiUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && res.status === 400) {
    // Откат всегда на голый sendMessage — если дело было в кривой картинке,
    // sendPhoto повторно тоже не поможет, а текст точно должен дойти.
    // Тоже без превью — иначе именно в момент отката вернётся та же карточка.
    // stripMarkdown, не сырой text — иначе в откате уходят живые **/* (см. выше).
    let plainBody = withNoPreview({ chat_id: chatId, text: stripMarkdown(text) });
    if (replyMarkup) plainBody.reply_markup = replyMarkup;
    res = await fetch(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plainBody),
    });
  }

  if (!res.ok) {
    throw new Error(`${method} ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function sendReviewMessage({ token, chatId, text, callbackId, photoUrl }) {
  return sendMessageRaw({
    token,
    chatId,
    text,
    photoUrl,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ Публикуй", callback_data: `pub:${callbackId}` },
          { text: "✏️ Правь", callback_data: `edit:${callbackId}` },
          { text: "❌ Отклони", callback_data: `rej:${callbackId}` },
        ],
      ],
    },
  });
}

// Клавиатура остаётся кликабельной у Telegram сама по себе, даже когда бот
// логически уже ушёл ждать текст правки — живой баг: клик по "Отклони" на
// старом сообщении после "Правь" тихо проглатывался как "не туда попали".
// Снимаем кнопки явно, как только определились с действием.
export async function clearKeyboard({ token, chatId, messageId }) {
  await fetch(apiUrl(token, "editMessageReplyMarkup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  }).catch(() => {}); // не критично — максимум кнопки повисят чуть дольше
}

// Публикация в канал — chatId либо числовой (-100...), либо "@username"
// для публичного канала. photoUrl опционален — есть не у всех тем
// (например, если og:image не нашёлся у источника).
export async function publishPost({ token, chatId, text, photoUrl }) {
  return sendMessageRaw({ token, chatId, text, photoUrl });
}

// То же самое тело запроса, что publishPost, но семантически другое —
// не публикация в канал, а вопрос владельцу в личку ("что поправить?").
// Не переиспользую publishPost напрямую ради ясности вызывающего кода.
export async function sendPlainMessage({ token, chatId, text }) {
  return sendMessageRaw({ token, chatId, text });
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
// подхватится как решение по текущей теме. Это верно для разового скрипта
// (review.js), но НЕ верно для демона (daemon.js): там "уже накопившееся"
// на старте — это ровно то сообщение, ради которого демон и держат
// запущенным (написали, пока демон перезапускался). flushPending: false
// пропускает слив — тогда то, что уже ждёт в очереди Telegram, не теряется.
async function initOffset(token, flushPending) {
  if (updateOffset !== null) return;
  if (!flushPending) {
    updateOffset = 0;
    return;
  }
  const res = await fetch(apiUrl(token, "getUpdates") + "?timeout=0");
  const data = await res.json();
  updateOffset = 0;
  for (const u of data.result ?? []) updateOffset = Math.max(updateOffset, u.update_id + 1);
}

// Ждёт нажатие именно на кнопки с этим callbackId. Клики по другим (устаревшим)
// сообщениям гасит явным ответом, чтобы кнопка не крутилась вечно у владельца.
// Возвращает "pub" / "edit" / "rej", или null по таймауту.
export async function waitForDecision({ token, callbackId, timeoutMs = 10 * 60 * 1000, flushPending = true }) {
  await initOffset(token, flushPending);
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
export async function waitForTextReply({ token, chatId, timeoutMs = 10 * 60 * 1000, flushPending = true }) {
  await initOffset(token, flushPending);
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
