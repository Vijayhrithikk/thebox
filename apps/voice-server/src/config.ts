import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

// dotenv parses `KEY=` as an empty string, not undefined — so an unset
// optional field like `ANTHROPIC_API_KEY=` would otherwise fail its own
// `.min(5)` check instead of being treated as "not provided". Strip empty
// values before validating so "KEY=" and a genuinely absent KEY behave
// identically, matching what anyone editing .env would expect.
for (const key of Object.keys(process.env)) {
  if (process.env[key] === "") delete process.env[key];
}

/**
 * Fail loudly at boot rather than three seconds into a live call.
 * Anything the call path touches is required; anything only a later phase
 * touches is optional so Phase 1 can run before every account exists.
 */
const schema = z.object({
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(10),
  TWILIO_PHONE_NUMBER: z.string().startsWith("+"),

  SARVAM_API_KEY: z.string().min(5),
  SARVAM_VOICE: z.string().default("priya"),
  SARVAM_MODEL: z.string().default("bulbul:v3"),

  SONIOX_API_KEY: z.string().min(5).optional(),

  /** Which model answers the phone. Both are wired behind the same LLMProvider interface — see brain/providers/. */
  LLM_PROVIDER: z.enum(["anthropic", "deepseek"]).default("anthropic"),

  ANTHROPIC_API_KEY: z.string().min(5).optional(),
  LLM_MODEL: z.string().default("claude-opus-5"),

  DEEPSEEK_API_KEY: z.string().min(5).optional(),
  /** deepseek-chat / deepseek-reasoner retired 2026-07-24 — deepseek-v4-pro is the current flagship. */
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-pro"),

  DATABASE_URL: z.string().optional(),

  WHATSAPP_DRIVER: z.enum(["web-session", "cloud-api"]).default("web-session"),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

  CANDIDATE_NAME: z.string().default(""),
  CANDIDATE_PHONE: z.string().default(""),

  PROSPECT_PHONE: z.string().default("+918688664337"),
  TEST_PHONE: z.string().optional(),

  PORT: z.coerce.number().default(8080),
  /** Public hostname Twilio dials back into. ngrok in dev, fly.dev in prod. */
  PUBLIC_HOST: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});
// Deliberately no cross-field "the selected provider's key must be set" check
// here. Both LLM keys stay .optional() at the schema level so standalone
// diagnostics (say.ts, and anything else that doesn't touch the brain) don't
// import this module and get blocked by a provider they never call. That
// check instead lives in brain/providers/index.ts, right next to the code
// that actually needs the key — see assertProviderConfigured().

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(
    `\nEnvironment is not ready:\n${missing}\n\nCopy .env.example to .env and fill it in — see docs/SETUP.md.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;

/** wss:// URL Twilio should open its media stream against. */
export function streamUrl(): string {
  if (!env.PUBLIC_HOST) {
    throw new Error("PUBLIC_HOST is not set — Twilio needs a public wss:// endpoint to stream to.");
  }
  const host = env.PUBLIC_HOST.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `wss://${host}/media`;
}
