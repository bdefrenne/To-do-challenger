/*
  ====================================================================
  THE BRAIN — one streamed Claude turn per message, driving the board
  through the SAME MCP server Claude Code uses.

  Shape (see docs/telegram.md for the full trace):
    • Model: Sonnet 5 — strong at tool use / ordering, cheap enough per msg.
    • MCP connector: Anthropic calls our deployed /api/mcp server-side with
      the user's per-user token, so reads/edits need zero glue here.
    • Destructive tools (delete_task, bulk_update, bulk_apply) are DISABLED
      on the connector — the model literally cannot run them. To do one it
      must call the client-side `propose_destructive` tool, which pauses the
      turn (stop_reason: tool_use) and hands the plan back to us for a
      Confirm tap. That makes the gate real, not prompt-hope.
    • We stream only to read tool-use events (status line); the answer text
      is taken from the final message.
  ====================================================================
*/

import Anthropic from "@anthropic-ai/sdk";
import type { ThreadTurn, PendingConfirm } from "@/lib/db/telegram";

const MODEL = "claude-sonnet-5";
const MCP_BETA = "mcp-client-2025-11-20";
/** Anthropic calls this from ITS servers, so it must be the deployed URL. */
const MCP_URL =
  (process.env.APP_URL || "https://to-do-challenger.vercel.app").replace(/\/$/, "") +
  "/api/mcp";

/** Destructive tools are switched off on the connector; only these three. */
const DESTRUCTIVE = ["delete_task", "bulk_update", "bulk_apply"] as const;

const SYSTEM = `You are a to-do assistant reachable over Telegram, on a phone.
Be terse: short sentences, no preamble, no sign-off. Use light Markdown (a bulleted list, *bold* for a task title) but keep it skimmable on a small screen.

You act through the "todo" MCP tools, which operate on the user's own board.
- For "what's on my todo" / "what's on today", call search_tasks for in-progress + planned tasks plus anything overdue — not the whole backlog.
- Before editing a task, resolve it with search_tasks first. If more than one plausibly matches, ask which one rather than guessing.
- After an edit, confirm what changed in one line (e.g. "✅ Updated *Onboarding* description").

You CANNOT delete tasks or make bulk changes directly — those tools are disabled. To do either, call the propose_destructive tool with a one-line summary and the exact tool call(s). The user will be asked to confirm before anything is deleted or bulk-changed. Never claim you deleted something you only proposed.`;

const PROPOSE_TOOL: Anthropic.Beta.BetaToolUnion = {
  type: "custom",
  name: "propose_destructive",
  // Cache breakpoint on the LAST tool caches the whole tools block — including
  // the big MCP toolset expansion — so it's read from cache on repeat turns
  // instead of re-billed/reprocessed as fresh input each message.
  cache_control: { type: "ephemeral" },
  description:
    "Propose a delete or bulk change for the user to confirm. You cannot delete or bulk-edit directly — describe the plan here and the user taps Confirm.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          'One-line description of what will happen, e.g. \'Delete "Onboarding" and its 2 subtasks\'.',
      },
      calls: {
        type: "array",
        description: "The exact destructive tool call(s) to run on approval.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", enum: [...DESTRUCTIVE] },
            input: {
              type: "object",
              description: "Arguments for that MCP tool (e.g. { id } or { ids, patch }).",
            },
          },
          required: ["tool", "input"],
        },
      },
    },
    required: ["summary", "calls"],
  },
};

/** tool name → the status line we show while it runs. */
function statusFor(tool: string): string {
  if (/^(list_|search_|get_|standup)/.test(tool) || tool === "list_projects")
    return "📋 Reading your board…";
  if (tool === "create_task") return "➕ Creating…";
  if (tool === "create_project" || tool === "create_board") return "🗂 Setting up…";
  if (tool.includes("calendar")) return "📅 Updating calendar…";
  if (/^(update_|move_|complete_|rename_|add_|record_|review_|lock_|link_)/.test(tool))
    return "✏️ Applying changes…";
  return "⚙️ Working…";
}

/** Token usage summed across every API round-trip of one question. */
export interface BrainUsage {
  input: number; // input_tokens summed across round-trips
  output: number; // output_tokens summed
  cacheRead: number; // cache_read_input_tokens summed
  cacheWrite: number; // cache_creation_input_tokens summed
  total: number; // input + output + cacheRead + cacheWrite
  calls: number; // # of API round-trips this turn took
}

export interface BrainResult {
  /** Final text to show, or null if only a proposal came back. */
  text: string | null;
  /** Set when the model asked to do something destructive — needs a tap. */
  proposal?: PendingConfirm;
  /** Tokens spent across the whole flow for this question. */
  usage: BrainUsage;
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

/**
 * Run one turn. `onStatus` fires as the model calls tools, so the webhook
 * can update the live status line. Returns the answer text and/or a
 * destructive proposal to confirm.
 */
export async function runBrain(opts: {
  mcpToken: string;
  thread: ThreadTurn[];
  userMessage: string;
  onStatus: (phrase: string) => void;
}): Promise<BrainResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...opts.thread.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: opts.userMessage },
  ];

  // Sum token usage across every round-trip (resumes included) of this turn.
  const usage: BrainUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    calls: 0,
  };
  const tally = (u: Anthropic.Beta.BetaUsage) => {
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.calls += 1;
    usage.total =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  };
  const done = (result: Omit<BrainResult, "usage">): BrainResult => {
    console.log("[telegram] usage", usage);
    return { ...result, usage };
  };

  // Resume loop: the server-side MCP tool loop can pause (pause_turn) if it
  // runs many tools; re-send to continue. Bounded so a loop can't run away.
  for (let i = 0; i < 5; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      betas: [MCP_BETA],
      // Cache the (static) system prompt too — cheap win on top of the tools.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      mcp_servers: [
        { type: "url", name: "todo", url: MCP_URL, authorization_token: opts.mcpToken },
      ],
      tools: [
        {
          type: "mcp_toolset",
          mcp_server_name: "todo",
          default_config: { enabled: true },
          // Per-tool overrides keyed by tool name — destructive tools off.
          configs: Object.fromEntries(
            DESTRUCTIVE.map((name) => [name, { enabled: false }]),
          ),
        },
        PROPOSE_TOOL,
      ],
      messages,
    });

    // Drive the status line off real tool-use events (MCP + our custom tool).
    stream.on("streamEvent", (event) => {
      if (
        event.type === "content_block_start" &&
        (event.content_block.type === "mcp_tool_use" ||
          event.content_block.type === "tool_use")
      ) {
        const name = (event.content_block as { name?: string }).name;
        if (name && name !== "propose_destructive") opts.onStatus(statusFor(name));
      }
    });

    const msg = await stream.finalMessage();
    tally(msg.usage);

    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue; // resume the server-side tool loop
    }

    // Did the model propose a destructive op? (client-side tool → we pause.)
    const proposeBlock = msg.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock =>
        b.type === "tool_use" && b.name === "propose_destructive",
    );
    if (proposeBlock) {
      const input = proposeBlock.input as PendingConfirm;
      return done({ text: textOf(msg), proposal: input });
    }

    return done({ text: textOf(msg) });
  }
  return done({ text: "That took too many steps — try narrowing the request." });
}

/** Join the text blocks of a message into one string. */
function textOf(msg: Anthropic.Beta.BetaMessage): string | null {
  const parts = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
