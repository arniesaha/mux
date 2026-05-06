import { createApp } from "./app.js";
import { config, validateStartupConfig } from "./config.js";
import { initTracing } from "./tracing.js";

validateStartupConfig(config);

await initTracing();

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Mux listening on http://localhost:${config.port}`);
});
