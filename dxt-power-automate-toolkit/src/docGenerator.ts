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
  dataConnections: DataConnection[];
}

interface AiSummaries {
  solutionSummary: string;
  flows: Record<string, string>;
}

export interface DataConnection {
  connector: string;   // e.g. "sharepointonline"
  resource: string;    // e.g. "Gas Self Renewal" (list/table/entity name)
  direction: 'read' | 'write';
  operationId: string;
  flowNames: string[]; // which flows reference this connection
}

function getConnector(action: any): string | undefined {
  const apiId: string | undefined = action.inputs?.host?.apiId;
  if (!apiId) { return undefined; }
  return apiId.split('/').pop();
}

// ── Data lineage helpers ──────────────────────────────────────────────────────

const READ_OPS = new Set([
  'getitems','getitem','getitems_v2','getitem_v2','getfilecontent','getfiles',
  'listrecords','getrecord','getrows','getrow','listrecords_v2',
  'getdatasets','getreports','gettables','getdatasetmetadata',
  'executepassthrough','executestoredprocedure',
  'getemailtips','getcontact','getuser','getuserfromdirectory',
]);

const WRITE_OPS = new Set([
  'createitem','updateitem','deleteitem','createitem_v2','updateitem_v2',
  'createfile','updatefile','deletefile','copyfile','movefile',
  'createrecord','updaterecord','deleterecord','upsertrecord',
  'insertrow','updaterow','deleterow','insertrowv2','updaterowv2',
  'addrowstodataset','refreshdataset','pushdatasetdata',
  'sendmailv2','sendmail','replyto','forward','sendemail',
  'postmessage','postadaptivecardtoconversation','sendnotification',
  'createevent','updateevent','deleteevent',
  'createtask','updatetask','deletetask',
]);

function classifyOperation(operationId: string, httpMethod?: string): 'read' | 'write' | null {
  const op = operationId.toLowerCase().replace(/[^a-z]/g, '');
  if (READ_OPS.has(op)) { return 'read'; }
  if (WRITE_OPS.has(op)) { return 'write'; }
  // HTTP method fallback
  if (httpMethod) {
    const m = httpMethod.toUpperCase();
    if (m === 'GET') { return 'read'; }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) { return 'write'; }
  }
  // Heuristic prefix matching
  const readPrefixes = ['get','list','read','fetch','query','search','find','retrieve','select'];
  const writePrefixes = ['create','update','delete','insert','add','set','send','post','put','patch','remove','upsert','append','refresh','push'];
  for (const p of readPrefixes) { if (op.startsWith(p)) { return 'read'; } }
  for (const p of writePrefixes) { if (op.startsWith(p)) { return 'write'; } }
  return null;
}

function extractResource(action: any): string {
  const params = action.inputs?.parameters ?? {};
  const isDynamic = (s: any) => typeof s !== 'string' || s.includes('@{');

  // Most connectors use 'table' for the primary entity (SharePoint list, SQL table, etc.)
  if (params.table && !isDynamic(params.table)) { return params.table; }
  // Dataverse entity name
  if (params.entityName && !isDynamic(params.entityName)) { return params.entityName; }
  // SQL table
  if (params.tableName && !isDynamic(params.tableName)) { return params.tableName; }
  // SharePoint site from dataset URL
  if (params.dataset && !isDynamic(params.dataset)) {
    const site = (params.dataset as string).match(/\/sites\/([^/?]+)/);
    if (site) { return site[1]; }
  }
  // Try to pull table out of the path string
  const pathStr: string | undefined = action.inputs?.path;
  if (pathStr && typeof pathStr === 'string') {
    const tbl = pathStr.match(/\/tables\/([^/?@{]+)/);
    if (tbl) { return decodeURIComponent(tbl[1]); }
  }
  return '';
}

function extractDataConnections(actions: Record<string, any>, flowName: string): DataConnection[] {
  const map = new Map<string, DataConnection>();

  function scan(acts: Record<string, any>) {
    for (const [, action] of Object.entries(acts)) {
      const apiId: string | undefined = action.inputs?.host?.apiId;
      const operationId: string = action.inputs?.host?.operationId ?? '';
      if (apiId && operationId) {
        const connector = apiId.split('/').pop() ?? '';
        const direction = classifyOperation(operationId, action.inputs?.method);
        if (direction) {
          const resource = extractResource(action);
          const key = `${connector}|${resource}|${direction}`;
          if (!map.has(key)) {
            map.set(key, { connector, resource, direction, operationId, flowNames: [] });
          }
          const entry = map.get(key)!;
          if (!entry.flowNames.includes(flowName)) { entry.flowNames.push(flowName); }
        }
      }
      // HTTP action (not a connector)
      if (action.type === 'Http' && action.inputs?.method) {
        const direction = classifyOperation('http', action.inputs.method);
        if (direction) {
          const uri: string = action.inputs.uri ?? '';
          const resource = uri.replace(/@\{[^}]+\}/g, '{…}').slice(0, 60);
          const key = `http|${resource}|${direction}`;
          if (!map.has(key)) {
            map.set(key, { connector: 'HTTP', resource, direction, operationId: action.inputs.method, flowNames: [] });
          }
          map.get(key)!.flowNames.push(flowName);
        }
      }
      if (action.actions) { scan(action.actions); }
      if (action.else?.actions) { scan(action.else.actions); }
    }
  }

  scan(actions);
  return [...map.values()];
}

function renderDataMap(connections: DataConnection[]): string[] {
  if (!connections.length) { return []; }
  const reads  = connections.filter(c => c.direction === 'read');
  const writes = connections.filter(c => c.direction === 'write');
  const lines: string[] = [];

  const fmt = (c: DataConnection) =>
    `**${c.connector}**${c.resource ? ` → \`${c.resource}\`` : ''}`;

  if (reads.length)  { lines.push(`📥 **Reads from:** ${reads.map(fmt).join(' · ')}`, ''); }
  if (writes.length) { lines.push(`📤 **Writes to:** ${writes.map(fmt).join(' · ')}`, ''); }
  return lines;
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
    const dataConnections = extractDataConnections(def.actions ?? {}, displayName);

    return { displayName, triggerLabel, isHttpTrigger, actions, connectors, hasErr, dataConnections };
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

    // ── Solution-level data map ────────────────────────────────────────────────
    const allConnections: DataConnection[] = [];
    for (const p of parsed) {
      if (!p) { continue; }
      for (const c of p.dataConnections) {
        const key = `${c.connector}|${c.resource}|${c.direction}`;
        const existing = allConnections.find(x => `${x.connector}|${x.resource}|${x.direction}` === key);
        if (existing) {
          for (const fn of c.flowNames) {
            if (!existing.flowNames.includes(fn)) { existing.flowNames.push(fn); }
          }
        } else {
          allConnections.push({ ...c, flowNames: [...c.flowNames] });
        }
      }
    }

    if (allConnections.length) {
      const reads  = allConnections.filter(c => c.direction === 'read');
      const writes = allConnections.filter(c => c.direction === 'write');
      lines.push(`### 🗄️ Data Connections`, ``);
      lines.push(`| Direction | Connector | Resource | Used in |`);
      lines.push(`|-----------|-----------|----------|---------|`);
      for (const c of reads) {
        lines.push(`| 📥 Read | \`${c.connector}\` | ${c.resource || '—'} | ${c.flowNames.join(', ')} |`);
      }
      for (const c of writes) {
        lines.push(`| 📤 Write | \`${c.connector}\` | ${c.resource || '—'} | ${c.flowNames.join(', ')} |`);
      }
      lines.push(``);
    }

    // ── Per-flow sections ──────────────────────────────────────────────────────
    for (let i = 0; i < flowFiles.length; i++) {
      const p = parsed[i];
      if (!p) {
        lines.push(`### ⚡ ${path.basename(flowFiles[i], '.json')}`, ``, `_Could not parse this flow file._`, ``);
        continue;
      }

      const { displayName, triggerLabel, isHttpTrigger, actions, connectors, hasErr, dataConnections } = p;
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

      // Per-flow data map
      lines.push(...renderDataMap(dataConnections));

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
