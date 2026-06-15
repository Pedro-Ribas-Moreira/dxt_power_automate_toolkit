import * as fs from 'fs';
import * as path from 'path';

export type Summarizer = (prompt: string) => Promise<string>;

interface FlatAction {
  name: string;
  type: string;
  connector?: string;
  operation?: string;
  depth: number;
}

interface ParsedFlow {
  displayName: string;
  triggerLabel: string;
  isHttpTrigger: boolean;
  actions: FlatAction[];
  connectors: string[];
  hasErr: boolean;
}

interface AiSummaries {
  solutionSummary: string;
  flows: Record<string, string>;
}

function getConnector(action: any): string | undefined {
  const apiId: string | undefined = action.inputs?.host?.apiId;
  if (!apiId) { return undefined; }
  return apiId.split('/').pop();
}

function topoSort(actions: Record<string, any>): string[] {
  const visited: Record<string, boolean> = {};
  const order: string[] = [];
  function visit(n: string) {
    if (visited[n]) { return; }
    visited[n] = true;
    const runAfter: Record<string, string[]> = actions[n]?.runAfter ?? {};
    for (const dep in runAfter) {
      if (actions[dep]) { visit(dep); }
    }
    order.push(n);
  }
  for (const n in actions) { visit(n); }
  return order;
}

function flattenActions(actions: Record<string, any>, depth = 0): FlatAction[] {
  if (!actions || typeof actions !== 'object') { return []; }
  const order = topoSort(actions);
  const result: FlatAction[] = [];
  for (const name of order) {
    const a = actions[name];
    result.push({
      name: name.replace(/_/g, ' '),
      type: a.type ?? 'Unknown',
      connector: getConnector(a),
      operation: a.inputs?.host?.operationId,
      depth,
    });
    if (a.actions && typeof a.actions === 'object') {
      result.push(...flattenActions(a.actions, depth + 1));
    }
    if (a.else?.actions && typeof a.else.actions === 'object') {
      result.push(...flattenActions(a.else.actions, depth + 1));
    }
  }
  return result;
}

function hasErrorHandling(actions: Record<string, any>): boolean {
  for (const a of Object.values(actions ?? {}) as any[]) {
    const ra: Record<string, string[]> = a.runAfter ?? {};
    for (const conds of Object.values(ra)) {
      if (conds.some(c => c === 'Failed' || c === 'TimedOut')) { return true; }
    }
    if (a.actions && hasErrorHandling(a.actions)) { return true; }
    if (a.else?.actions && hasErrorHandling(a.else.actions)) { return true; }
  }
  return false;
}

function parseFlowFile(flowFilePath: string): ParsedFlow | null {
  try {
    const raw = fs.readFileSync(flowFilePath, 'utf8');
    const flow = JSON.parse(raw);
    const def = flow.properties?.definition ?? flow.definition ?? flow;

    const baseName = path.basename(flowFilePath, '.json');
    const displayName = baseName
      .replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '')
      .replace(/-/g, ' ');

    const triggers: Record<string, any> = def.triggers ?? {};
    const triggerEntry = Object.values(triggers)[0] as any;
    const triggerType: string = triggerEntry?.type ?? 'Unknown';
    const triggerKind: string | undefined = triggerEntry?.kind;
    const triggerLabel = triggerKind ? `${triggerType}/${triggerKind}` : triggerType;
    const isHttpTrigger = triggerType === 'Request';

    const actions = flattenActions(def.actions ?? {});
    const connectors = [...new Set(actions.map(a => a.connector).filter((c): c is string => !!c))];
    const hasErr = hasErrorHandling(def.actions ?? {});

    return { displayName, triggerLabel, isHttpTrigger, actions, connectors, hasErr };
  } catch {
    return null;
  }
}

async function buildAiSummaries(
  solName: string,
  flows: ParsedFlow[],
  summarize: Summarizer
): Promise<AiSummaries | null> {
  const flowLines = flows.map((f, i) => {
    const topActions = f.actions.filter(a => a.depth === 0).slice(0, 8).map(a => a.name).join(', ');
    return `${i + 1}. "${f.displayName}": trigger=${f.triggerLabel}, connectors=[${f.connectors.join(', ') || 'none'}], key_steps=[${topActions}]`;
  }).join('\n');

  const prompt = `You are writing documentation for Power Automate automation flows used at Prepay Power, an Irish energy company.

Solution: "${solName}"
Flows:
${flowLines}

Your task:
1. For each flow, write exactly ONE sentence in plain business English describing what it does. Focus on the business outcome, not the technical steps.
2. Write 2 sentences describing what this solution achieves as a whole — its business purpose and who benefits.

Respond ONLY with valid JSON (no markdown, no code fences, no other text):
{
  "solutionSummary": "...",
  "flows": {
    "Flow Name 1": "...",
    "Flow Name 2": "..."
  }
}`;

  try {
    const raw = await summarize(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { return null; }
    return JSON.parse(match[0]) as AiSummaries;
  } catch {
    return null;
  }
}

export async function generateSolutionDocs(
  solutionsRoot: string,
  summarize?: Summarizer,
  onProgress?: (msg: string) => void
): Promise<string> {
  const solutionDirs = fs.readdirSync(solutionsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Power Automate Solutions — Documentation`,
    ``,
    `> Auto-generated by DXT Power Automate Toolkit on ${today}${summarize ? ' · AI summaries included' : ''}`,
    ``,
  ];

  for (const solName of solutionDirs) {
    const workflowsDir = path.join(solutionsRoot, solName, 'Workflows');
    if (!fs.existsSync(workflowsDir)) { continue; }

    const flowFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
    if (!flowFiles.length) { continue; }

    // Parse all flows in this solution
    const parsed: Array<ParsedFlow | null> = flowFiles.map(f =>
      parseFlowFile(path.join(workflowsDir, f))
    );

    // AI summaries — one batched call per solution
    let aiSummaries: AiSummaries | null = null;
    if (summarize) {
      onProgress?.(`Summarising ${solName}…`);
      const validFlows = parsed.filter((p): p is ParsedFlow => p !== null);
      aiSummaries = await buildAiSummaries(solName, validFlows, summarize);
    }

    lines.push(`---`, ``);
    lines.push(`## 📦 ${solName}`, ``);

    if (aiSummaries?.solutionSummary) {
      lines.push(`> ${aiSummaries.solutionSummary}`, ``);
    }

    lines.push(`**${flowFiles.length} flow${flowFiles.length !== 1 ? 's' : ''}**`, ``);

    for (let i = 0; i < flowFiles.length; i++) {
      const p = parsed[i];
      if (!p) {
        lines.push(`### ⚡ ${path.basename(flowFiles[i], '.json')}`, ``, `_Could not parse this flow file._`, ``);
        continue;
      }

      const { displayName, triggerLabel, isHttpTrigger, actions, connectors, hasErr } = p;
      const badges: string[] = [];
      if (hasErr) { badges.push('✅ Error handling'); } else { badges.push('⚠️ No error handling'); }
      if (isHttpTrigger) { badges.push('⚠️ Register in APIM'); }

      lines.push(`### ⚡ ${displayName}`, ``);

      // AI flow summary — try exact match first, then fuzzy match
      const flowSummary = aiSummaries?.flows?.[displayName] ??
        Object.entries(aiSummaries?.flows ?? {}).find(([k]) =>
          k.replace(/ /g, '').toLowerCase() === displayName.replace(/ /g, '').toLowerCase()
        )?.[1];

      if (flowSummary) {
        lines.push(`> ${flowSummary}`, ``);
      }

      if (badges.length) { lines.push(badges.join('&ensp;·&ensp;'), ``); }
      lines.push(`**Trigger:** \`${triggerLabel}\``, ``);

      if (actions.length) {
        lines.push(`| # | Action | Type | Connector | Operation |`);
        lines.push(`|---|--------|------|-----------|-----------|`);
        actions.forEach((a, idx) => {
          const indent = '  '.repeat(a.depth);
          lines.push(`| ${idx + 1} | ${indent}${a.name} | \`${a.type}\` | ${a.connector ?? '—'} | ${a.operation ?? '—'} |`);
        });
        lines.push(``);
      }

      if (connectors.length) {
        lines.push(`**Connectors used:** ${connectors.join(', ')}`, ``);
      }
    }
  }

  return lines.join('\n');
}
