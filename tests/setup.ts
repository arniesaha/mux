/**
 * Vitest setup: strip .env-leaked keys before config.ts loads.
 *
 * The config module skips dotenv.config() when VITEST="true", but the
 * parent shell may still have loaded values into process.env. Parse our
 * committed .env.example to discover every config key and delete it
 * so the suite starts from defaults.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const examplePath = fileURLToPath(
  new URL("../.env.example", import.meta.url).href,
);

const keys = readFileSync(examplePath, "utf-8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => line.split("=")[0])
  .filter((key) => key.length > 0);

for (const key of keys) {
  delete process.env[key];
}

// Ensure tests always see the conventional NODE_ENV.
process.env.NODE_ENV = "test";
