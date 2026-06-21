/**
 * Orchestrator entry point.
 * Poll loop: tick() every POLL_INTERVAL_MS, heartbeat every 60s.
 */
import { tick, processHumanReviews } from "./state-machine.js";
import { heartbeat } from "./db.js";
import { config } from "./config.js";

const { pollIntervalMs, instanceId } = config.orchestrator;

console.log(`[orchestrator] starting — instance=${instanceId} poll=${pollIntervalMs}ms`);

let lastHeartbeat = 0;

async function loop() {
  while (true) {
    try {
      await tick();
      await processHumanReviews();
    } catch (err) {
      console.error("[orchestrator] unhandled tick error:", err);
    }

    // Heartbeat every ~60s (independent of poll interval)
    if (Date.now() - lastHeartbeat > 60_000) {
      await heartbeat(instanceId).catch(() => {});
      lastHeartbeat = Date.now();
    }

    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

loop().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
