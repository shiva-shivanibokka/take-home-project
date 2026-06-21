import "dotenv/config";

function require_env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  supabase: {
    url: require_env("SUPABASE_URL"),
    serviceKey: require_env("SUPABASE_SERVICE_ROLE_KEY"),
  },
  orchestrator: {
    // How often the poll loop ticks (ms)
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),
    // Seconds before a locked job is considered stale (agent hung/crashed)
    lockTimeoutSecs: Number(process.env.LOCK_TIMEOUT_SECS ?? 120),
    // Max retries per stage before marking failed
    maxRetries: Number(process.env.MAX_RETRIES ?? 3),
    // Base backoff ms — doubles each retry
    backoffBaseMs: Number(process.env.BACKOFF_BASE_MS ?? 8_000),
    // Unique ID for this orchestrator instance (used in locked_by)
    instanceId: process.env.HOSTNAME ?? "orchestrator",
  },
  openclaw: {
    // Path to openclaw CLI on the VPS
    cliPath: process.env.OPENCLAW_CLI_PATH ?? "openclaw",
    // Workspaces root for per-agent skills
    workspacesRoot: process.env.OPENCLAW_WORKSPACES_ROOT ??
      "/home/ubuntu/.openclaw/workspaces",
  },
};
