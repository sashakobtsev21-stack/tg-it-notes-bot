// Тонкая обёртка над Gemini REST API — намеренно один файл, не общий
// LLM-интерфейс. Когда подключим Anthropic (Claude), после оплаты —
// правится один этот файл и вызывающий код в draft.js/score.js, не вся
// кодовая база.

// "-latest" вместо конкретной версии специально: конкретные версии у Google
// вымирают быстро (2.5-pro/2.5-flash за время этой сессии уже стали 404/0-квота
// на новом ключе) — алиас сам едет на актуальную бесплатную модель.
//
// Две разные модели специально, не одна: замер 02.08 — свободный тариф
// gemini-flash-latest (сейчас 3.6-flash) даёт всего 20 запросов/СУТКИ
// (не в минуту — это дневной квотоId), и черновики+скоринг на одной модели
// упираются в лимит за один прогон конвейера. gemini-flash-lite-latest —
// отдельная модель, отдельная (нетронутая) квота. Дешёвую частую задачу
// (оценка интересности — десятки вызовов за прогон) держим на lite, дорогую
// редкую (сам текст поста) — на обычной flash ради качества письма.
const MODEL_TEXT = "gemini-flash-latest";
const MODEL_CLASSIFY = "gemini-flash-lite-latest";
const RETRYABLE_STATUS = new Set([429, 500, 503]);

function endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// Google периодически отдаёт 429/500/503 — видел вживую 503 "high demand" и
// 429 (дневная квота), не гипотетика. Один повтор с паузой лечит транзиентные
// 500/503; для 429 с дневным лимитом это бесполезно (и не вредно) — реальный
// выход из 429 — использовать другую модель, см. выше.
async function callGemini(model, generationConfig, { system, user }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY не задан — добавьте в .env");
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  });

  let res;
  let errBody;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${endpoint(model)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.ok) break;
    errBody = await res.text();
    if (attempt === 0 && RETRYABLE_STATUS.has(res.status)) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    throw new Error(`Gemini API (${model}) ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? "";

  if (!text) {
    throw new Error(`Gemini не вернул текст (finishReason: ${candidate?.finishReason ?? "unknown"})`);
  }
  return text.trim();
}

// 3.6-flash по умолчанию "думает" перед ответом, и это тоже часть
// maxOutputTokens (видел вживую: 381 токен на размышления при лимите 400 —
// на сам текст поста не осталось места). thinkingBudget: 0 модель не приняла,
// поэтому просто даём запасу токенов больше, чем нужно на ответ.
export async function generateText({ system, user, maxOutputTokens = 2048, temperature = 0.9 }) {
  return callGemini(MODEL_TEXT, { temperature, maxOutputTokens }, { system, user });
}

// То же самое, но с JSON-схемой ответа и на lite-модели — для скоринга
// интересности и подобных высокочастотных, но простых задач классификации.
export async function generateJSON({ system, user, schema, maxOutputTokens = 1024 }) {
  const text = await callGemini(
    MODEL_CLASSIFY,
    { temperature: 0.3, maxOutputTokens, responseMimeType: "application/json", responseSchema: schema },
    { system, user }
  );
  return JSON.parse(text);
}
