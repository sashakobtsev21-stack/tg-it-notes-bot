// Репозитории, чьи релизы отслеживаем через GitHub Atom-фид (releases.atom).
// Добавить новый источник — просто дописать "owner/repo" в список.
//
// Замер 02.08: SDK-клиенты (anthropic-sdk-python/typescript, openai-python) и
// langchain-ai/langchain (тегирует релизом КАЖДЫЙ суб-пакет отдельно) почти
// всегда рутинные патчи — классификатор интересности их и так топит, но
// незачем тратить вызовы модели на заведомый шум. Убраны. Вместо них —
// репозитории, где реальные новые возможности выходят чаще.
export const githubRepos = [
  "anthropics/claude-code",
  "ollama/ollama",
  "ggerganov/llama.cpp",
  "vllm-project/vllm",
  "huggingface/transformers",
  "open-webui/open-webui",
  "comfyanonymous/ComfyUI",
  "Aider-AI/aider",
];

// Ключевые слова для поиска на Hacker News через Algolia API.
export const hnKeywords = [
  "Claude",
  "GPT",
  "Anthropic",
  "OpenAI",
  "Gemini",
  "LLM",
  "AI agent",
];
