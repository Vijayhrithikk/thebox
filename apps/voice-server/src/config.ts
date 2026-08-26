import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

// dotenv parses `KEY=` as an empty string, not undefined — so an unset
// optional field would otherwise fail its own `.min(5)` check instead of
// being treated as "not provided". Strip empty values before validating so
// "KEY=" and a genuinely absent KEY behave identically.
for (const key of Object.keys(process.env)) {
  if (process.env[key] === "") delete process.env[key];
}

/**
 * Scoped to exactly what this server does now: a single LLM (DeepSeek, used
 * only by callbackResolver.ts to turn spoken time into a datetime, and by
 * followup.ts to compose the post-call message), WhatsApp (Baileys), and
 * the two files that go out in the post-call follow-up. Twilio, Telnyx,
 * Soniox, our own Sarvam TTS streaming, and Anthropic were all real,
 * working code earlier in this project — removed once Sarvam's managed
 * agent took over the entire live call. See PROGRESS.md for that history;
 * it's not lost, just not live.
 *
 * Exotel was tried first for the scheduled-callback re-dial, hit a real
 * bug in Sarvam's campaign dialer (bridging mode instead of single-leg),
 * and was dropped once the number moved to one rented directly through
 * Sarvam. Telephony now goes entirely through Sarvam's Instant Outbound
 * API (telephony/sarvam.ts) — both the initial call and the re-dial place
 * calls the same way, straight to the same agent, with caller_number set
 * explicitly as an agent_variable rather than relying on an ambiguous
 * built-in. These fields are optional so callbackScheduler.ts still
 * resolves and records a requested callback time even if unset — it just
 * can't place the re-dial itself; see its comment for what degrades.
 */
const schema = z.object({
  SARVAM_API_KEY: z.string().min(5).optional(),
  SARVAM_ORG_ID: z.string().optional(),
  SARVAM_WORKSPACE_ID: z.string().optional(),
  SARVAM_APP_ID: z.string().optional(),
  SARVAM_APP_VERSION: z.coerce.number().optional(),
  SARVAM_CONNECTION_ID: z.string().optional(),
  /** The Sarvam-rented number the agent calls out from, e.g. "+918071579499". */
  SARVAM_AGENT_PHONE_NUMBER: z.string().optional(),

  DEEPSEEK_API_KEY: z.string().min(5),
  /** deepseek-chat / deepseek-reasoner retired 2026-07-24 — this is the current flagship. Only used for the low-volume callback-time resolution call. */
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-pro"),

  DATABASE_URL: z.string().optional(),

  /** Shared secret checked against the X-Webhook-Secret header on all /webhooks/* routes — see server.ts's checkWebhookAuth. Optional so nothing breaks before it's set on both this server and Sarvam's tool config, but should be set in production. */
  WEBHOOK_SECRET: z.string().optional(),

  CANDIDATE_NAME: z.string().default(""),
  CANDIDATE_PHONE: z.string().default(""),
  /** Sent with the post-call follow-up — see actions/followup.ts. Relative to this process's cwd (apps/voice-server), so these point back up to the project-root assets/ folder. */
  RESUME_PATH: z.string().default("../../assets/resume.pdf"),
  ARCHITECTURE_IMAGE_PATH: z.string().default("../../assets/architecture.png"),

  PROSPECT_PHONE: z.string().default("+918688664337"),
  TEST_PHONE: z.string().optional(),

  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default("info"),
});

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
