/**
 * invoke-agent.ts
 *
 * Invokes an OpenClaw agent for a single stage by running the agent's stage
 * skill as a Node.js child process.
 *
 * ARCHITECTURE NOTE (read before modifying):
 * -------------------------------------------
 * OpenClaw's documented programmatic invocation is via its CLI. Each agent
 * owns a workspace at $OPENCLAW_WORKSPACES_ROOT/<agentId>/ and exposes
 * executable skills in skills/.
 *
 * The orchestrator shells out:
 *   node <workspacesRoot>/<agentId>/skills/run.mjs --job <jobId>
 *
 * Each skill script is a standalone Node.js ESM module that:
 *   1. Reads its upstream artifact from Supabase (by job_id).
 *   2. Calls Ollama Cloud for LLM work.
 *   3. Writes its artifact + handoff record back to Supabase.
 *   4. Exits 0 on success, non-zero on failure.
 *
 * If OpenClaw gains a clean CLI trigger for agents in future (e.g.
 *   `openclaw run --agent collector --job <id>`),
 * swap the exec call below — everything else stays the same.
 *
 * The skill scripts are "running under OpenClaw" in the sense that their
 * workspace, SOUL.md persona, and AGENTS.md instructions are defined there,
 * and the same Node runtime OpenClaw ships is used to execute them.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

export type AgentId = "collector" | "writer" | "reviewer";

export async function invokeAgent(
  agentId: AgentId,
  jobId: string,
  timeoutMs: number
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const skillPath = path.join(
    config.openclaw.workspacesRoot,
    agentId,
    "skills",
    "run.mjs"
  );

  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let settled = false;

    const child = spawn("node", [skillPath, "--job", jobId], {
      env: {
        ...process.env,
        AGENT_ID: agentId,
        JOB_ID: jobId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d: Buffer) => out.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => err.push(d.toString()));

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        resolve({
          success: false,
          stdout: out.join(""),
          stderr: `[orchestrator] Agent ${agentId} timed out after ${timeoutMs}ms\n` + err.join(""),
        });
      }
    }, timeoutMs);

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: code === 0,
          stdout: out.join(""),
          stderr: err.join(""),
        });
      }
    });
  });
}
