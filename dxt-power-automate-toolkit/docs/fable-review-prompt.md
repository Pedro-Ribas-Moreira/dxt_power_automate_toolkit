# ROLE
You are a senior staff engineer and product design reviewer. You are auditing a
VS Code extension for a real internal tool. Be direct, specific, and evidence-based.
Praise only what deserves it; every criticism must name a file and line and say why
it matters. No filler, no restating the code back to me.

# WHAT THE PROJECT IS
"DXT Power Automate Toolkit" — a VS Code extension used by a 3-person Digital
Transformation team at an Irish energy company (Yuno Energy Group / PrepayPower)
to develop Microsoft Power Automate flows locally. It:
- exposes environments/solutions/flows in tree views and pulls/pushes them via the
  `pac` CLI (pacCli.ts) and the Power Automate/Dataverse REST APIs (paApi.ts, dataverseApi.ts)
- indexes flow JSON into a searchable "action library" (libraryBuilder.ts) and renders
  it plus a flow visualizer in webviews (media/library.js, media/visualizer.js)
- auto-generates an AI-context file (CLAUDE.md) and FLOWS.md docs (docGenerator.ts)
  from curated Power Automate knowledge (resources/pa-knowledge.json, knowledge.ts)
  plus company context (companyContext.ts)
- syncs a shared index to SharePoint (sharepoint.ts, cloudIndexBuilder.ts)
- integrates Asana tasks (asana*.ts) and ships an MCP server (mcp/pa-server.js) so
  AI assistants can query the same knowledge.
The audience is 3 internal power-users, not a public marketplace release.

# WHAT TO READ (and what to ignore)
Read the actual source, in roughly this priority order:
1. package.json  (contributes: commands, views, menus — the whole UX surface)
2. src/extension.ts  (activation, command wiring — the spine; ~1800 lines)
3. src/*.ts  (all ~24 modules: treeProvider, pacCli, libraryBuilder, paApi,
   dataverseApi, sharepoint, docGenerator, companyContext, knowledge, asana*, etc.)
4. resources/pa-knowledge.json  (the curated Power Automate knowledge base)
5. mcp/pa-server.js
6. media/*.js and media/*.css  (webview UI: library.js, visualizer.js, theme.css, etc.)
IGNORE node_modules/, dist/, out/, and generated *.md dumps except to sanity-check them.
Do not evaluate code you have not read. If you sample rather than read fully, say so.

# PHASE 1 — REVIEW
Evaluate on these six axes. For EACH axis, give a 1-line verdict, then concrete findings.

1. IS THIS THE BEST APPROACH?
   Judge the architecture and the core bet (a VS Code extension wrapping pac CLI +
   REST APIs + webviews + an MCP server). Where does the design fight the platform?
   Would a simpler or different structure serve 3 internal users better? Call out
   coupling, the 1800-line extension.ts, duplicated logic, auth/secret handling,
   and the CLI-vs-API split. Name viable alternatives only if clearly better.

2. WHAT IS BEING EXECUTED WELL
   Specific strengths worth keeping and building on. Be concrete (file:line), not
   flattering. If something is merely fine, say fine — reserve praise for the real wins.

3. WHAT NEEDS IMPROVEMENT
   Correctness bugs, error handling, security (secret storage, tokens, SharePoint
   creds), performance (large flow indexing, webview payloads), maintainability,
   test coverage (there is ~one test file), and dead/unfinished code. Rank by severity.

4. GOOD ADDITIONS
   High-leverage features or capabilities that fit the existing architecture and this
   team's workflow (Power Automate ALM, Asana, SharePoint, MCP/AI). Prioritize by
   value-to-effort. No feature-list padding — 5-8 ideas that actually matter.

5. UX / MODERN UI
   Judge against current VS Code extension UX guidelines and modern UI principles:
   - native look & feel: does it use VS Code theme tokens, codicons, and standard
     tree/quickpick/webview patterns? (check media/theme.css, media/icons.js, webviews)
   - discoverability & command surface (~30 commands, menu grouping in package.json)
   - onboarding / first-run (the secret-prompt on activate in extension.ts, viewsWelcome)
   - feedback: progress, errors, toasts (media/toast.js), empty states
   - accessibility, keyboard nav, light/dark theming, responsive webviews
   Give at least 5 concrete, actionable UX fixes.

6. KNOWLEDGE & CONTEXT QUALITY  (are we getting the best out of the embedded knowledge?)
   This tool's real value is the knowledge it feeds to AI assistants. Evaluate the
   knowledge/context layer specifically:
   - resources/pa-knowledge.json (Power Automate expression syntax, limits, patterns,
     best practices — distilled from 4 Microsoft Learn URLs, with a `lastUpdated` stamp)
   - src/knowledge.ts (renders that JSON into the generated CLAUDE.md)
   - src/companyContext.ts (org/brand/systems/naming conventions)
   - src/libraryBuilder.ts generateClaudeMd() + src/docGenerator.ts (how it's all
     assembled and what the final CLAUDE.md / FLOWS.md looks like)
   Assess, with specifics:
   a) ACCURACY — is any of the embedded PA guidance wrong, outdated, or misleading?
      (e.g. limits, connector operations, expression syntax, runAfter/type casing rules)
      Flag anything that could steer an AI to generate broken flow JSON.
   b) CURRENCY — the source is a handful of MS Learn pages fetched on one date. What is
      MISSING or stale vs. current Microsoft Power Automate / Logic Apps documentation?
      Is `lastUpdated` respected anywhere, or can knowledge silently rot? Is there any
      mechanism to refresh it from Microsoft Learn?
   c) COVERAGE / GAPS — what high-value MS Learn topics are absent that this team clearly
      needs? (e.g. connector reference for the connectors they actually use — SharePoint,
      SQL, Office 365, Dataverse, HTTP, Teams, Approvals; solution/ALM & environment-
      variable guidance; child flows; error-handling patterns; throttling limits per
      connector; Copilot Studio topic/YAML schema; adaptive card schema).
   d) SHOULD WE APPLY MORE MS LEARN DATA? — give a direct recommendation: is the current
      curated ~300-line JSON the right size and shape, or should it be expanded, split,
      or restructured? If expand: name the specific Microsoft Learn areas to ingest and
      in what form (curated JSON vs. full-text vs. on-demand fetch/RAG), and weigh
      breadth vs. the risk of bloating the CLAUDE.md context window.
   e) STRUCTURE FOR AI CONSUMPTION — is the knowledge organized so an LLM uses it
      reliably (signal-to-noise, ordering, examples, org-specific vs. generic separation)?
      Would restructuring measurably improve flow-JSON generation quality?
   Give a clear verdict on (d) — expand, keep as-is, or restructure — with reasoning.

## PHASE 1 OUTPUT FORMAT
- Start with a 6-line EXECUTIVE SUMMARY (one line per axis: verdict + headline).
- Then one section per axis, using the numbering above.
- Within each section, use a bulleted list. Every finding:
    - [severity: high/med/low]  file.ts:line — the issue — why it matters — the fix
- End Phase 1 with a "TOP 5 THINGS TO DO NEXT" ranked list cutting across all axes.
Be concise. Cite evidence. Where you are uncertain or did not read something, say so
explicitly rather than guessing.

# PHASE 2 — FIX (only after I approve)
After you present the review, STOP and wait. Do not edit any files yet.
I will reply with which findings to fix (e.g. "do TOP 5" or specific items).
Then, for each approved item:
- make the change as a real edit to the file
- keep each fix minimal and self-contained; match surrounding style
- after all edits, run `npm run lint` and `npm run compile` and report results
- give me a summary: what changed, file:line, and anything you chose NOT to touch and why
Do NOT bundle unrelated refactors into a fix. One finding = one focused change.
Architecture (axis 1) and UX/knowledge-strategy items (axes 5, 6d) are usually
proposals, not mechanical fixes — discuss those with me before applying, don't auto-edit.
