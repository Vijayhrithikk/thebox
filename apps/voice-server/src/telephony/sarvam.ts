import { env } from "../config.js";

const BASE_URL = "https://apps.sarvam.ai/api/outbounds/v1";

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

/**
 * Places a call through Sarvam's Voice Agents "Instant Outbound" API —
 * the same engine that runs the live conversation, so this reaches the
 * rebuilt agent directly instead of routing through a separate telephony
 * provider. `agent_variables.caller_number` is set explicitly here, which
 * is what fixed the earlier bug where the agent's tool bodies picked up
 * an ambiguous built-in variable (once seen holding the Sarvam account's
 * own email) instead of the number actually being called.
 */
export async function placeCall({ to }: PlaceCallOptions) {
  const response = await fetch(
    `${BASE_URL}/orgs/${env.SARVAM_ORG_ID}/workspaces/${env.SARVAM_WORKSPACE_ID}/outbounds`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": env.SARVAM_API_KEY!,
      },
      body: JSON.stringify({
        app_config: {
          app_id: env.SARVAM_APP_ID,
          app_version: env.SARVAM_APP_VERSION,
          app_type: "agent",
          connection_config: {
            connection_id: env.SARVAM_CONNECTION_ID,
            agent_phone_number: env.SARVAM_AGENT_PHONE_NUMBER,
          },
          agent_variables: {
            caller_number: to,
          },
        },
        user_config: {
          user_phone_number: to,
        },
        ...(env.PUBLIC_BASE_URL
          ? {
              webhook_config: {
                url: `${env.PUBLIC_BASE_URL}/webhooks/call-completed`,
                // Echoed back verbatim in the webhook payload (per Sarvam's docs) —
                // used as a lightweight authenticity check on the receiving end,
                // since this endpoint isn't triggered by the agent's own tool auth.
                metadata: env.WEBHOOK_SECRET ? { secret: env.WEBHOOK_SECRET } : undefined,
              },
            }
          : {}),
      }),
    },
  );

  const data = (await response.json()) as { attempt_id?: string; message?: string; error?: string };
  if (!response.ok || !data.attempt_id) {
    throw new Error(`Sarvam outbound call failed: ${data.message ?? data.error ?? response.statusText}`);
  }

  return data;
}
