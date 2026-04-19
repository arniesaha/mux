// Importing these modules for side-effects: each adapter calls
// registerAdapter() at module load so the registry can instantiate providers
// when buildRegistry() runs. Import this barrel once from the app composition
// root (src/app.ts) — do NOT import it from downstream.ts, which would
// create a circular import.
import "./anthropic-sdk.js";
import "./openai-compatible.js";

export { getProvider, listProviders, __resetProviderRegistryForTests } from "./registry.js";
