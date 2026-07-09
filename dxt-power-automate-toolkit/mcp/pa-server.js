import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const SOLUTIONS_ROOT = process.env.SOLUTIONS_ROOT || '';

function loadLibrary() {
  if (!SOLUTIONS_ROOT) { return null; }
  const libPath = path.join(SOLUTIONS_ROOT, '.pa-library.json');
  if (!fs.existsSync(libPath)) { return null; }
  try { return JSON.parse(fs.readFileSync(libPath, 'utf8')); }
  catch { return null; }
}

const server = new McpServer({ name: 'power-automate', version: '1.0.0' });

// ─── search_pa_actions ────────────────────────────────────────────────────────
// Find connectors/operations matching a query, with real JSON examples from your org

server.tool(
  'search_pa_actions',
  'Search your org\'s action library for connectors and operations. Returns real JSON snippets from your own flows.',
  { query: z.string().describe('Connector name, operation name, or action type — e.g. "sharepoint", "send email", "HTTP"') },
  async ({ query }) => {
    const lib = loadLibrary();
    if (!lib) {
      return { content: [{ type: 'text', text: 'Library not built yet. Open the Power Automate Toolkit panel and click Build Library.' }] };
    }

    const q = query.toLowerCase();
    const results = [];

    for (const [cKey, conn] of Object.entries(lib.connectors)) {
      const connMatches = conn.displayName.toLowerCase().includes(q) || cKey.toLowerCase().includes(q);
      for (const [oKey, op] of Object.entries(conn.operations)) {
        const opMatches = op.displayName.toLowerCase().includes(q) || oKey.toLowerCase().includes(q);
        if (connMatches || opMatches) {
          results.push({
            connector: conn.displayName,
            connectorKey: cKey,
            operation: op.displayName,
            operationKey: oKey,
            timesUsedInOrg: op.count,
            exampleJSON: op.examples[0]?.snippet ?? null,
            moreExamples: op.examples.length
          });
        }
      }
    }

    results.sort((a, b) => b.timesUsedInOrg - a.timesUsedInOrg);
    const top = results.slice(0, 10);

    if (!top.length) {
      return { content: [{ type: 'text', text: `No actions found matching "${query}". Try a broader term.` }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify(top, null, 2) }] };
  }
);

// ─── list_pa_flows ────────────────────────────────────────────────────────────
// List every flow available locally across all solutions

server.tool(
  'list_pa_flows',
  'List all Power Automate flows available locally, grouped by solution.',
  {},
  async () => {
    if (!SOLUTIONS_ROOT || !fs.existsSync(SOLUTIONS_ROOT)) {
      return { content: [{ type: 'text', text: 'SOLUTIONS_ROOT is not set or the folder does not exist.' }] };
    }

    const flows = [];
    for (const sol of fs.readdirSync(SOLUTIONS_ROOT)) {
      if (sol.startsWith('.')) { continue; }
      const wfDir = path.join(SOLUTIONS_ROOT, sol, 'Workflows');
      if (!fs.existsSync(wfDir)) { continue; }
      for (const file of fs.readdirSync(wfDir).filter(f => f.endsWith('.json'))) {
        const flowName = file.replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\.json$/i, '');
        flows.push({ solution: sol, flow: flowName });
      }
    }

    if (!flows.length) {
      return { content: [{ type: 'text', text: 'No flows found locally. Export some solutions first.' }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify(flows, null, 2) }] };
  }
);

// ─── get_pa_flow ──────────────────────────────────────────────────────────────
// Read a specific flow's full action structure

server.tool(
  'get_pa_flow',
  'Read the full action structure of a specific local flow.',
  {
    solution: z.string().describe('Solution folder name — e.g. "PPPRetentionRetentionComms"'),
    flow: z.string().describe('Flow name or partial match — e.g. "SendWelcome"')
  },
  async ({ solution, flow }) => {
    if (!SOLUTIONS_ROOT) {
      return { content: [{ type: 'text', text: 'SOLUTIONS_ROOT is not set.' }] };
    }

    const wfDir = path.join(SOLUTIONS_ROOT, solution, 'Workflows');
    if (!fs.existsSync(wfDir)) {
      return { content: [{ type: 'text', text: `Solution folder "${solution}" not found at ${wfDir}` }] };
    }

    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.json'));
    const match = files.find(f => f.toLowerCase().includes(flow.toLowerCase()));
    if (!match) {
      return { content: [{ type: 'text', text: `No flow matching "${flow}" in "${solution}". Available: ${files.map(f => f.replace(/-[A-F0-9-]+\.json$/i, '')).join(', ')}` }] };
    }

    const raw = JSON.parse(fs.readFileSync(path.join(wfDir, match), 'utf8'));
    const def = raw.properties?.definition || raw.definition || raw;
    const trigger = def.triggers ? Object.entries(def.triggers)[0] : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: match.replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\.json$/i, ''),
          trigger: trigger ? { name: trigger[0], type: trigger[1].type } : null,
          actions: def.actions || {}
        }, null, 2)
      }]
    };
  }
);

// ─── get_pa_examples ─────────────────────────────────────────────────────────
// Get real usage examples for a specific connector + operation from your org

server.tool(
  'get_pa_examples',
  'Get real JSON usage examples for a connector/operation from your org\'s flows. Useful for understanding exactly how an action is configured in practice.',
  {
    connector: z.string().describe('Connector name or key — e.g. "SharePoint" or "shared_sharepointonline"'),
    operation: z.string().optional().describe('Operation name or key — e.g. "GetItems". Omit to list all operations for this connector.')
  },
  async ({ connector, operation }) => {
    const lib = loadLibrary();
    if (!lib) {
      return { content: [{ type: 'text', text: 'Library not built yet.' }] };
    }

    const q = connector.toLowerCase();
    const connEntry = Object.entries(lib.connectors).find(
      ([k, v]) => k.toLowerCase().includes(q) || v.displayName.toLowerCase().includes(q)
    );

    if (!connEntry) {
      const available = Object.values(lib.connectors).map(c => c.displayName).join(', ');
      return { content: [{ type: 'text', text: `Connector "${connector}" not found. Available: ${available}` }] };
    }

    const [, conn] = connEntry;

    if (!operation) {
      const ops = Object.entries(conn.operations)
        .map(([k, v]) => ({ key: k, name: v.displayName, timesUsed: v.count }))
        .sort((a, b) => b.timesUsed - a.timesUsed);
      return { content: [{ type: 'text', text: JSON.stringify(ops, null, 2) }] };
    }

    const oq = operation.toLowerCase();
    const opEntry = Object.entries(conn.operations).find(
      ([k, v]) => k.toLowerCase().includes(oq) || v.displayName.toLowerCase().includes(oq)
    );

    if (!opEntry) {
      return { content: [{ type: 'text', text: `Operation "${operation}" not found in ${conn.displayName}.` }] };
    }

    const [, op] = opEntry;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ operation: op.displayName, timesUsedInOrg: op.count, examples: op.examples }, null, 2)
      }]
    };
  }
);

// ─── get_connection_refs ─────────────────────────────────────────────────────
// Exact connectionReferences blobs + common variables + trigger frequency from
// the enriched library index — paste-ready context for writing new flow JSON.

server.tool(
  'get_connection_refs',
  'Get the org\'s connection-reference JSON blobs (paste verbatim into properties.connectionReferences of new flows), plus common variable names and trigger-type frequency.',
  {},
  async () => {
    const lib = loadLibrary();
    if (!lib) {
      return { content: [{ type: 'text', text: 'Library not built yet. Open the Power Automate Toolkit panel and click Build Library.' }] };
    }
    if (!lib.connectionRefs && !lib.variables && !lib.triggers) {
      return { content: [{ type: 'text', text: 'Library not enriched yet — rebuild it with "Build Library from Local Solutions" (toolkit v0.3+).' }] };
    }

    const topVariables = Object.entries(lib.variables || {})
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30)
      .map(([name, v]) => ({ name, type: v.type, count: v.count }));

    const triggerFrequency = Object.entries(lib.triggers || {})
      .sort((a, b) => b[1].count - a[1].count)
      .map(([label, t]) => ({ trigger: label, count: t.count }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          connectionRefs: lib.connectionRefs || {},
          topVariables,
          triggerFrequency,
        }, null, 2)
      }]
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
