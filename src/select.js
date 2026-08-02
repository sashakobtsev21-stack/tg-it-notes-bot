import { runPipeline } from "./pipeline.js";
import { bucketOf } from "./score.js";

const { rawCount, clusters } = await runPipeline();

console.log(`Собрано ${rawCount} штук -> ${clusters.length} тем после дедупа\n`);

for (const c of clusters) {
  console.log(
    `[${c.score.toFixed(1)} | ${bucketOf(c.score)}] ${c.title}\n` +
      `  ${c.url}\n` +
      `  источников: ${c.sourceCount} (${c.sources.join(", ")}) | ` +
      `формат: ${c.breakdown.format} | новизна: ${c.breakdown.novelty} | ` +
      `доверие: ${c.breakdown.confidence} | скорость: ${c.breakdown.velocity} | ` +
      `давность×${c.breakdown.recency}\n`
  );
}
