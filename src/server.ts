import { createApp } from "./app.js";
import { config } from "./config.js";
import { initTracing } from "./tracing.js";

await initTracing();

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Mux listening on http://localhost:${config.port}`);
});
