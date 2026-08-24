/**
 * The agent-facing setup guide, handed to a teammate's coding agent so their repo
 * starts working from the todo board.
 *
 * GENERATED from `docs/todo-mcp-setup.md` by `npm run gen:setup-guide` — edit the doc, not this file.
 */
export const TODO_SETUP_GUIDE = `# Set up the todo MCP workflow in your project

> **Hand this whole file to your coding agent** (Claude Code, or paste it into a session) and say:
> *"Follow this document to set up this repo."* It will ask you for one token and do the rest.
>
> Everything it writes is repo-local and committed, so once one person runs it, every teammate who
> clones the repo gets the same behaviour — they only need to supply their own token.

## What this achieves

Your agent treats **To-do Challenger as the source of truth for work**: before it changes anything
in the repo — however small — it finds or creates a task, sets it to *Analyzing* (which locks a
permanent code ref like \`PLAT-505\`), and records analysis/plan/summary as it goes. You get a record
of every change an agent made, and why.

Three pieces make that happen, and all three are needed. Instructions alone are not enough — the
agent also needs the tools connected, and a per-session reminder so the rule doesn't fade out of
attention in a long session.

| Piece | File | Purpose |
|---|---|---|
| MCP server registration | \`.mcp.json\` | gives the agent \`create_task\`, \`update_task\`, … |
| The rule | \`CLAUDE.md\` | tells the agent when and how to use them |
| SessionStart hook | \`.claude/settings.json\` | re-injects the rule at the top of every session |

---

## Agent instructions

Do these in order. Stop and ask the human wherever the doc says to.

### Step 0 — get the human's token

Ask the human for their **personal** To-do Challenger MCP token (it looks like \`todo_…\`, from their
To-do Challenger account settings). **Never** use someone else's token, and never write a token
into any committed file.

Tell them to put it in their shell profile (\`~/.zshrc\` / \`~/.bashrc\`) and restart the shell:

\`\`\`sh
export TODO_MCP_TOKEN="todo_xxxxxxxxxxxxxxxxxxxxxxxx"
\`\`\`

If no token is available yet, still do Steps 1–3 — the config is inert without the env var and
costs nothing — then tell the human what's left to do.

### Step 1 — register the server (\`.mcp.json\` at the repo root)

Create it, or merge the \`todo\` key into the existing \`mcpServers\` object if the file exists:

\`\`\`json
{
  "mcpServers": {
    "todo": {
      "type": "http",
      "url": "https://to-do-challenger.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer \${TODO_MCP_TOKEN}" }
    }
  }
}
\`\`\`

\`\${VAR}\` is expanded by Claude Code at connect time, so this file stays token-free and is safe to
commit. Commit it. Claude Code asks each teammate to approve a project-scoped server the first time
they open the repo — that's expected, they should approve it.

*Solo dev who doesn't want this in the repo?* Run

\`\`\`sh
claude mcp add --transport http todo https://to-do-challenger.vercel.app/api/mcp \\
  --header "Authorization: Bearer $TODO_MCP_TOKEN" -s user
\`\`\`

and skip to Step 2. Note a user-scoped server shadows the project one, so if you later add
\`.mcp.json\` too, remove the user-scoped copy (\`claude mcp remove todo -s user\`) or you'll be testing
something your teammates don't have.

### Step 2 — find where tasks go, then write the rule into \`CLAUDE.md\`

Once the server is connected, call \`list_projects\` and look for the project/board matching this
repo. **Confirm the match with the human** — do not guess, and do not create a new project without
asking. If nothing fits, ask whether to create one.

Then add this section to the repo's root \`CLAUDE.md\` (create the file if there isn't one),
substituting the real project, board, and code prefix:

\`\`\`markdown
## Always work from the todo

When the **\`todo\` MCP server is connected**, To-do Challenger is the source of truth for work.
**Before starting a meaningful change** — something worth being able to find again later — do
this first:

1. **Find the task.** \`search_tasks\` / \`list_tasks\` to check whether one already exists. If a
   plausible match exists, use it — don't create a duplicate. If it's ambiguous which one, ask.
2. **Create it if it doesn't exist.** \`create_task\` under **<PROJECT> → <BOARD> (\`<CODE>\`)**, with
   a clear title and a description written from what the human actually asked for.
3. **Set it to Analyzing right away.** \`update_task status:"analyzing"\` — this locks the task's
   code ref. Then follow the todo MCP's own workflow (analyze → plan → build), recording
   \`analysisSummary\` / \`plan\` / \`summary\` as you go.

### The test

> **Would this show up in a standup, or in release notes?**
> If yes, it's a task. If it's invisible to everyone but the person who typed it, it isn't. If you
> can't tell, **ask the human** — don't guess in either direction.

Apply that test first, every time. The board is a record of what the product did and why, not a log
of every keystroke; a board full of "bump the dependency" and "change a value" is worse than no
board, because the real work gets buried.

The lists below are worked examples of the test — when an example and the test disagree, the test
wins.

**Create a task for:** a new feature or a change to behaviour a user would notice · a bug fix for
something a user could actually hit · a contract or data-shape change (API surface, schema,
migration) · anything that forces a change in another repo · deleting or replacing a component,
route, or flow · auth, permissions, or secrets · refactors spanning several files or changing
architecture · anything the human described as a problem in their own words · work spanning more
than one session, or that someone else has to verify.

**Don't create a task for:** dependency bumps with no behaviour change · tuning a constant,
threshold, or magic number · typos, comments, formatting, lint and type fixes · renaming a local,
tidying imports, dead-code removal · debug logging, temporary harnesses, scratch files · reverting
your own work from earlier in the session · generated files and lockfiles · read-only work that
ends in an answer rather than an edit · follow-ups an **existing** task already covers (update that
one instead).

**Ask when:** it's small but user-facing (copy, layout, a visible tweak) · a value change alters
balance or how the product feels · the human called it quick but it's growing to several files ·
you found an unrelated real bug mid-task (own task, or fold it in?) · it's trivial in size but
lands somewhere risky (payments, auth, user data) · you can't tell whether an existing task covers
it.

Keep bookkeeping lightweight — don't log for the sake of logging. When working a task, read the
code **directly**; another task's analysis or summary is background context, not a map of the
current codebase.

If the \`todo\` MCP is **not** connected, ignore all of the above and just do the work.

**Setup:** this needs \`TODO_MCP_TOKEN\` exported in your shell — see \`.mcp.json\` and
\`docs/todo-mcp-setup.md\`.
\`\`\`

Keep it near the top of \`CLAUDE.md\`; it competes for attention with everything else in there.

**It goes in the repo's \`CLAUDE.md\`, never in the human's global \`~/.claude/CLAUDE.md\`.** The board
mapping in point 2 is true for *this* repo only — put it in the global file and every other project
they open inherits a rule pointing at the wrong board.

### Step 3 — add the SessionStart reminder (\`.claude/settings.json\`)

This is the piece that actually keeps the rule salient in a long session. Create the file, or merge
the \`SessionStart\` entry into an existing \`hooks\` object:

\`\`\`json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"SessionStart\\",\\"additionalContext\\":\\"Reminder (todo MCP workflow): THE TEST for whether work needs a task — would this show up in a standup, or in release notes? If yes it is a task; if it is invisible to everyone but the person who typed it, it is not; if you cannot tell, ASK the user rather than guessing either way. So before starting a MEANINGFUL change — a feature, a bug a user could hit, a contract/schema change, anything worth finding again later — first check the todo MCP (search_tasks / list_tasks) for an existing task; create one if missing (in the repo-mapped project/board per CLAUDE.md); then set it to Analyzing to lock the code ref. Do NOT open tasks for trivia: dependency bumps, tuning a constant, typos, comments, formatting, debug or throwaway code, or read-only investigation. Borderline cases to ask about: small but user-facing, small but risky, or possibly covered by an existing task. Keep bookkeeping lightweight. When working a task, read the code DIRECTLY — do not infer where code lives from other tasks (their analysis/plan/summary are background context, not a map of the current codebase).\\"}}'"
          }
        ]
      }
    ]
  }
}
\`\`\`

Commit \`.claude/settings.json\` (it's the shared one). Make sure \`.claude/settings.local.json\` is
gitignored — that's each person's private overrides and must never be committed:

\`\`\`gitignore
.claude/settings.local.json
\`\`\`

Each teammate approves the project hook once, on their first session after pulling.

### Step 4 — verify, and report honestly

1. Start a fresh session in the repo. \`/mcp\` should list \`todo\` as connected (project scope).
2. The SessionStart reminder should be present in context at the top of the session.
3. Ask for a trivial change and confirm the agent creates a task under the right board and moves it
   to *Analyzing* **before** editing anything.
4. Unset \`TODO_MCP_TOKEN\` and start a session: \`todo\` fails to connect and the agent falls back to
   just doing the work. The repo must stay usable for anyone without a token.

Tell the human exactly which steps landed and which didn't — especially if the token wasn't
available, or if the project/board mapping is still a placeholder.

---

## Notes for the human

- **Tokens are personal.** Each dev exports their own \`TODO_MCP_TOKEN\`; tasks then get attributed
  to the right person, since moving a task to Analyzing or Building auto-assigns it to whoever's
  token is in play.
- **One repo at a time, on purpose.** Repeat this in each repo you work on, with that repo's own
  board mapping. The three files are identical apart from the \`<PROJECT> → <BOARD> (<CODE>)\` line.
  Resist the shortcut of putting the rule in your global \`~/.claude/CLAUDE.md\` to cover everything
  at once: the mapping is per-project, so a global copy sends tasks from every other repo to the
  wrong board — and it stays yours alone, so no teammate inherits it, which is the whole problem
  this document exists to fix.
`;
