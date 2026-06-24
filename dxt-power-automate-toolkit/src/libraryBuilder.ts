import * as fs from 'fs';
import * as path from 'path';

export interface LibraryExample {
  solution: string;
  flow: string;
  actionName: string;
  snippet: any;
}

export interface LibraryOperation {
  displayName: string;
  count: number;
  examples: LibraryExample[];
}

export interface LibraryConnector {
  displayName: string;
  icon: string;
  count: number;
  operations: Record<string, LibraryOperation>;
}

export type BotPatternKind = 'AdaptiveCard' | 'FlowCall' | 'Question' | 'Message';

export interface BotPattern {
  kind: BotPatternKind;
  displayName: string;
  topic: string;
  solution: string;
  snippet: string;  // raw YAML or JSON string — copy as-is
}

export interface Library {
  lastUpdated: string;
  solutionsScanned: number;
  flowsScanned: number;
  topicsScanned: number;
  connectors: Record<string, LibraryConnector>;
  botPatterns: BotPattern[];
}

// ─── Connector / operation display names ─────────────────────────────────────

const CONNECTORS: Record<string, { name: string; icon: string }> = {
  // ── Cloud connectors (shared_* prefix) ──
  shared_sharepointonline:            { name: 'SharePoint',              icon: '$(database)' },
  shared_office365:                   { name: 'Office 365 Outlook',      icon: '$(mail)' },
  shared_office365users:              { name: 'Office 365 Users',        icon: '$(person)' },
  shared_teams:                       { name: 'Microsoft Teams',         icon: '$(comment-discussion)' },
  shared_commondataserviceforapps:    { name: 'Dataverse',               icon: '$(server)' },
  shared_commondataservice:           { name: 'Dataverse (legacy)',       icon: '$(server)' },
  shared_flowpush:                    { name: 'Power Apps Notification', icon: '$(bell)' },
  shared_sendgrid:                    { name: 'SendGrid',                icon: '$(mail)' },
  shared_azureblob:                   { name: 'Azure Blob Storage',      icon: '$(cloud)' },
  shared_azurequeues:                 { name: 'Azure Queue Storage',     icon: '$(list-unordered)' },
  shared_sql:                         { name: 'SQL Server',              icon: '$(database)' },
  shared_onedriveforbusiness:         { name: 'OneDrive for Business',   icon: '$(file-directory)' },
  shared_onedrive:                    { name: 'OneDrive',                icon: '$(file-directory)' },
  shared_excelonlinebusiness:         { name: 'Excel Online',            icon: '$(table)' },
  shared_planner:                     { name: 'Planner',                 icon: '$(checklist)' },
  shared_powerbi:                     { name: 'Power BI',                icon: '$(graph)' },
  shared_approvals:                   { name: 'Approvals',               icon: '$(pass)' },
  shared_outlook:                     { name: 'Outlook.com',             icon: '$(mail)' },
  shared_gmail:                       { name: 'Gmail',                   icon: '$(mail)' },
  shared_slack:                       { name: 'Slack',                   icon: '$(comment-discussion)' },
  shared_azuread:                     { name: 'Azure AD',                icon: '$(shield)' },
  shared_keyvault:                    { name: 'Azure Key Vault',         icon: '$(key)' },
  shared_servicebus:                  { name: 'Service Bus',             icon: '$(broadcast)' },
  shared_dynamicscrmonline:           { name: 'Dynamics 365',            icon: '$(server)' },
  shared_documentdb:                  { name: 'Azure Cosmos DB',         icon: '$(database)' },
  shared_twilio:                      { name: 'Twilio',                  icon: '$(device-mobile)' },
  shared_smtp:                        { name: 'SMTP',                    icon: '$(mail)' },

  // ── Built-in action types ──
  Compose:                            { name: 'Compose',                 icon: '$(edit)' },
  Http:                               { name: 'HTTP',                    icon: '$(globe)' },
  Foreach:                            { name: 'Apply to each',           icon: '$(sync)' },
  If:                                 { name: 'Condition',               icon: '$(git-branch)' },
  Switch:                             { name: 'Switch',                  icon: '$(git-branch)' },
  Until:                              { name: 'Do until',                icon: '$(sync)' },
  Scope:                              { name: 'Scope',                   icon: '$(group-by-ref-type)' },
  InitializeVariable:                 { name: 'Variables',               icon: '$(symbol-variable)' },
  SetVariable:                        { name: 'Variables',               icon: '$(symbol-variable)' },
  AppendToStringVariable:             { name: 'Variables',               icon: '$(symbol-variable)' },
  AppendToArrayVariable:              { name: 'Variables',               icon: '$(symbol-variable)' },
  IncrementVariable:                  { name: 'Variables',               icon: '$(symbol-variable)' },
  DecrementVariable:                  { name: 'Variables',               icon: '$(symbol-variable)' },
  ParseJson:                          { name: 'Parse JSON',              icon: '$(json)' },
  Response:                           { name: 'Response',                icon: '$(reply)' },
  Terminate:                          { name: 'Terminate',               icon: '$(stop)' },
  Delay:                              { name: 'Delay',                   icon: '$(clock)' },
  Wait:                               { name: 'Delay',                   icon: '$(clock)' },
  Query:                              { name: 'Filter array',            icon: '$(filter)' },
  Select:                             { name: 'Select',                  icon: '$(list-selection)' },
  Table:                              { name: 'Create HTML table',       icon: '$(table)' },
  Join:                               { name: 'Join',                    icon: '$(combine)' },
  Workflow:                           { name: 'Child flow',              icon: '$(repo-forked)' },
};

const OPERATIONS: Record<string, string> = {
  // ── SharePoint ──
  GetItems: 'Get items',                    GetItem: 'Get item',
  CreateItem: 'Create item',               UpdateItem: 'Update item',
  DeleteItem: 'Delete item',               GetLists: 'Get lists',
  GetListViews: 'Get list views',          GetAttachments: 'Get attachments',
  AddAttachment: 'Add attachment',         GetFileContent: 'Get file content',
  CreateFile: 'Create file',               UpdateFile: 'Update file',
  DeleteFile: 'Delete file',               ListFolder: 'List folder',

  // ── Dataverse / CDS (OpenApiConnection style) ──
  PostItem: 'Add a new row',               PatchItem: 'Update a row',
  DeleteItem_V2: 'Delete a row',           GetItem_V2: 'Get a row',
  GetItems_V2: 'List rows',               ExecuteDatasetQuery: 'List rows (query)',
  InvokeAction: 'Perform an action',       Associate: 'Relate rows',
  Disassociate: 'Unrelate rows',

  // ── Outlook / Office 365 ──
  SendEmail: 'Send an email',              SendEmailV2: 'Send an email (V2)',
  SendMailWithOptions: 'Send email with options',
  CreateEvent: 'Create event',            GetEvents: 'Get events',
  ReplyToEmail: 'Reply to email',

  // ── Teams ──
  PostMessage: 'Post message',            PostMessageToChannel: 'Post to channel',
  PostAdaptiveCardAndWaitForResponse: 'Post adaptive card',
  GetTeams: 'Get teams',                  GetChannels: 'Get channels',

  // ── Users ──
  GetUser: 'Get user',                    GetUsers: 'Get users (V2)',
  GetManagerV2: 'Get manager (V2)',       SearchUsers: 'Search users',

  // ── HTTP ──
  POST: 'HTTP POST',                       GET: 'HTTP GET',
  PUT: 'HTTP PUT',                         PATCH: 'HTTP PATCH',
  DELETE: 'HTTP DELETE',
};

// ─── Key extraction ───────────────────────────────────────────────────────────

function connectorKey(action: any, connRefs: Record<string, any>): string {
  if (action.type === 'OpenApiConnection') {
    // Newer style: connectionName is a plain string directly on inputs.host
    const connName = action.inputs?.host?.connectionName;
    if (connName) { return connName; }
    // Fallback: extract from apiId path e.g. /providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps
    const apiId: string = action.inputs?.host?.apiId || '';
    const m = apiId.match(/\/apis\/([^/]+)$/);
    if (m) { return m[1]; }
  }

  if (action.type === 'ApiConnection') {
    // Legacy style: connection name is an expression referencing $connections
    const expr: string = action.inputs?.host?.connection?.name || '';
    const m = expr.match(/\['([^']+)'\]\['connectionId'\]/);
    if (m && connRefs[m[1]]?.api?.name) { return connRefs[m[1]].api.name; }
    if (m && connRefs[m[1]]) { return m[1]; }
  }

  return action.type || 'Unknown';
}

function operationKey(action: any): string {
  if (action.type === 'OpenApiConnection') {
    // Newer style: operationId is always explicit
    return action.inputs?.host?.operationId || 'unknown';
  }

  if (action.type === 'ApiConnection') {
    const opId = action.inputs?.host?.operationId;
    if (opId) { return opId; }
    // Infer from HTTP method + path for older SharePoint/legacy connectors
    const method = (action.inputs?.method || 'GET').toUpperCase();
    const p: string = action.inputs?.path || '';
    if (p.includes('/items') && method === 'GET')    { return 'GetItems'; }
    if (p.includes('/items') && method === 'POST')   { return 'CreateItem'; }
    if (p.includes('/items') && method === 'PATCH')  { return 'UpdateItem'; }
    if (p.includes('/items') && method === 'DELETE') { return 'DeleteItem'; }
    if (p.includes('/SendEmail'))                    { return 'SendEmail'; }
    if (p.includes('/PostMessage'))                  { return 'PostMessage'; }
    return `${method}_${p.split('/').filter(Boolean).pop() || 'action'}`;
  }

  return action.type || 'unknown';
}

function connectorDisplay(key: string): { name: string; icon: string } {
  return CONNECTORS[key] || { name: key.replace(/^shared_/, '').replace(/_/g, ' '), icon: '$(plug)' };
}

function operationDisplay(key: string, action: any): string {
  return OPERATIONS[key] || action.inputs?.host?.operationId || key.replace(/_/g, ' ');
}

function cleanSnippet(action: any): any {
  const { runAfter: _, metadata: __, ...rest } = action;
  return rest;
}

// ─── Indexer ──────────────────────────────────────────────────────────────────

function indexActions(
  actions: Record<string, any>,
  connRefs: Record<string, any>,
  solution: string,
  flow: string,
  lib: Library
): void {
  for (const [name, action] of Object.entries(actions)) {
    const cKey = connectorKey(action, connRefs);
    const oKey = operationKey(action);
    const { name: cName, icon } = connectorDisplay(cKey);
    const oName = operationDisplay(oKey, action);

    if (!lib.connectors[cKey]) {
      lib.connectors[cKey] = { displayName: cName, icon, count: 0, operations: {} };
    }
    const conn = lib.connectors[cKey];
    conn.count++;

    if (!conn.operations[oKey]) {
      conn.operations[oKey] = { displayName: oName, count: 0, examples: [] };
    }
    const op = conn.operations[oKey];
    op.count++;

    if (op.examples.length < 5) {
      op.examples.push({ solution, flow, actionName: name, snippet: cleanSnippet(action) });
    }

    // recurse into nested actions
    if (action.actions) { indexActions(action.actions, connRefs, solution, flow, lib); }
    if (action.else?.actions) { indexActions(action.else.actions, connRefs, solution, flow, lib); }
  }
}

// ─── Bot topic indexer ────────────────────────────────────────────────────────

function extractYamlBlock(lines: string[], startIdx: number): string[] {
  const baseIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0;
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { block.push(line); continue; }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= baseIndent) { break; }
    block.push(line);
  }
  return block;
}

function indexBotTopics(solutionsRoot: string, lib: Library): void {
  for (const sol of fs.readdirSync(solutionsRoot)) {
    if (sol.startsWith('.')) { continue; }
    const botDir = path.join(solutionsRoot, sol, 'botcomponents');
    if (!fs.existsSync(botDir)) { continue; }

    for (const topicDir of fs.readdirSync(botDir).filter(d => d.includes('.topic.'))) {
      const dataPath = path.join(botDir, topicDir, 'data');
      if (!fs.existsSync(dataPath)) { continue; }

      const topicName = topicDir.split('.topic.').pop() ?? topicDir;
      let yaml: string;
      try { yaml = fs.readFileSync(dataPath, 'utf8'); } catch { continue; }
      lib.topicsScanned++;

      const lines = yaml.split('\n');
      let cardCounter = 0;
      let flowCounter = 0;
      let questionCounter = 0;
      const addedMessages = new Set<string>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const kindMatch = line.match(/^(\s*)- kind:\s+(\w+)/);
        if (!kindMatch) { continue; }
        const kind = kindMatch[2];

        // ── Adaptive cards ───────────────────────────────────────────────────
        if (kind === 'AdaptiveCardPrompt' || kind === 'AdaptiveCardTemplate') {
          const block = extractYamlBlock(lines, i);
          const cardLineIdx = block.findIndex(l => l.includes('card: |-') || l.includes('cardContent: |-'));
          if (cardLineIdx === -1) { continue; }
          const baseIndent = (block[cardLineIdx + 1]?.match(/^(\s*)/)?.[1].length ?? 0);
          const cardLines: string[] = [];
          for (let j = cardLineIdx + 1; j < block.length; j++) {
            const l = block[j];
            if (l.trim() === '') { break; }
            const ind = l.match(/^(\s*)/)?.[1].length ?? 0;
            if (ind < baseIndent) { break; }
            cardLines.push(l.slice(baseIndent));
          }
          if (!cardLines.length) { continue; }
          cardCounter++;
          lib.botPatterns.push({
            kind: 'AdaptiveCard',
            displayName: `Card ${cardCounter} — ${topicName}`,
            topic: topicName,
            solution: sol,
            snippet: cardLines.join('\n'),
          });
        }

        // ── Flow calls ───────────────────────────────────────────────────────
        if (kind === 'InvokeFlowAction') {
          const block = extractYamlBlock(lines, i);
          flowCounter++;
          const flowIdLine = block.find(l => l.includes('flowId:'));
          const flowId = flowIdLine?.match(/flowId:\s+([a-f0-9-]{36})/i)?.[1] ?? '';
          lib.botPatterns.push({
            kind: 'FlowCall',
            displayName: `Flow call ${flowCounter} — ${topicName}`,
            topic: topicName,
            solution: sol,
            snippet: block.map(l => l.trimStart()).join('\n'),
          });
        }

        // ── Questions ────────────────────────────────────────────────────────
        if (kind === 'Question') {
          const block = extractYamlBlock(lines, i);
          questionCounter++;
          const varLine = block.find(l => /variable:/.test(l));
          const varName = varLine?.match(/variable:\s+(.+)/)?.[1]?.trim() ?? 'Unknown';
          lib.botPatterns.push({
            kind: 'Question',
            displayName: `Question → ${varName}`,
            topic: topicName,
            solution: sol,
            snippet: block.map(l => l.trimStart()).join('\n'),
          });
        }

        // ── Bot messages ─────────────────────────────────────────────────────
        if (kind === 'SendActivity') {
          const nextLine = lines[i + 1] ?? '';
          const activityMatch = nextLine.match(/activity:\s+(.+)/);
          if (activityMatch) {
            const msg = activityMatch[1].trim();
            if (!addedMessages.has(msg) && msg.length > 5) {
              addedMessages.add(msg);
              lib.botPatterns.push({
                kind: 'Message',
                displayName: msg.slice(0, 60) + (msg.length > 60 ? '…' : ''),
                topic: topicName,
                solution: sol,
                snippet: `- kind: SendActivity\n  activity: ${msg}`,
              });
            }
          }
        }
      }
    }
  }
}

export function buildLibrary(solutionsRoot: string): Library {
  const lib: Library = {
    lastUpdated: new Date().toISOString(),
    solutionsScanned: 0,
    flowsScanned: 0,
    topicsScanned: 0,
    connectors: {},
    botPatterns: [],
  };

  if (!fs.existsSync(solutionsRoot)) { return lib; }

  for (const sol of fs.readdirSync(solutionsRoot)) {
    if (sol.startsWith('.')) { continue; }
    const wfDir = path.join(solutionsRoot, sol, 'Workflows');
    if (!fs.existsSync(wfDir)) { continue; }
    lib.solutionsScanned++;

    for (const file of fs.readdirSync(wfDir).filter(f => f.endsWith('.json'))) {
      const flowName = file.replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\.json$/i, '');
      try {
        const flow = JSON.parse(fs.readFileSync(path.join(wfDir, file), 'utf8'));
        lib.flowsScanned++;
        const def = flow.properties?.definition || flow.definition || flow;
        const connRefs = flow.properties?.connectionReferences || {};
        indexActions(def.actions || {}, connRefs, sol, flowName, lib);
      } catch { /* skip corrupt */ }
    }
  }

  indexBotTopics(solutionsRoot, lib);
  return lib;
}

export function saveLibrary(lib: Library, solutionsRoot: string): void {
  fs.writeFileSync(path.join(solutionsRoot, '.pa-library.json'), JSON.stringify(lib, null, 2), 'utf8');
}

export function loadLibrary(solutionsRoot: string): Library | null {
  const libPath = path.join(solutionsRoot, '.pa-library.json');
  if (!fs.existsSync(libPath)) { return null; }
  try { return JSON.parse(fs.readFileSync(libPath, 'utf8')); }
  catch { return null; }
}

/**
 * Merge `patch` into `base`, returning a combined library.
 * - Connectors/operations: union of examples, deduped by solution+flow+actionName.
 *   `patch` examples take precedence (added first when both have the same slot).
 * - Bot patterns: deduped by kind+solution+topic+displayName.
 * - Counts: summed, reflecting the combined scan coverage.
 * - Solutions/flows scanned: summed (rough — may double-count shared solutions).
 */
export function mergeLibraries(base: Library, patch: Library): Library {
  // Deep-clone base connectors so we don't mutate the original
  const connectors: Record<string, LibraryConnector> = JSON.parse(JSON.stringify(base.connectors ?? {}));

  for (const [cKey, pConn] of Object.entries(patch.connectors ?? {})) {
    if (!connectors[cKey]) {
      connectors[cKey] = JSON.parse(JSON.stringify(pConn));
      continue;
    }
    const rConn = connectors[cKey];
    rConn.count += pConn.count;

    for (const [oKey, pOp] of Object.entries(pConn.operations)) {
      if (!rConn.operations[oKey]) {
        rConn.operations[oKey] = JSON.parse(JSON.stringify(pOp));
        continue;
      }
      const rOp = rConn.operations[oKey];
      rOp.count += pOp.count;

      // Merge examples: patch examples first (fresher), dedup by solution+flow+actionName
      const seen = new Set(pOp.examples.map(e => `${e.solution}|${e.flow}|${e.actionName}`));
      const merged = [...pOp.examples];
      for (const ex of rOp.examples) {
        const key = `${ex.solution}|${ex.flow}|${ex.actionName}`;
        if (!seen.has(key)) { merged.push(ex); seen.add(key); }
      }
      rOp.examples = merged.slice(0, 5); // keep at most 5
    }
  }

  // Merge bot patterns: dedup by kind+solution+topic+displayName
  const bpSeen = new Set((patch.botPatterns ?? []).map(p => `${p.kind}|${p.solution}|${p.topic}|${p.displayName}`));
  const botPatterns = [...(patch.botPatterns ?? [])];
  for (const p of (base.botPatterns ?? [])) {
    const key = `${p.kind}|${p.solution}|${p.topic}|${p.displayName}`;
    if (!bpSeen.has(key)) { botPatterns.push(p); bpSeen.add(key); }
  }

  return {
    lastUpdated: new Date().toISOString(),
    solutionsScanned: (base.solutionsScanned ?? 0) + (patch.solutionsScanned ?? 0),
    flowsScanned: (base.flowsScanned ?? 0) + (patch.flowsScanned ?? 0),
    topicsScanned: (base.topicsScanned ?? 0) + (patch.topicsScanned ?? 0),
    connectors,
    botPatterns,
  };
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function buildCompanySection(workspaceRoot: string): string {
  const ctxPath = path.join(workspaceRoot, 'company-context.json');
  if (!fs.existsSync(ctxPath)) { return ''; }
  let ctx: any;
  try { ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8')); } catch { return ''; }

  const lines: string[] = [];

  // ── Organisation ──
  lines.push(`## Organisation`, ``);
  const brandSummary = (ctx.brands ?? [])
    .map((b: any) => `${b.name} (${b.prefix})`)
    .join(', ');
  lines.push(`**${ctx.group ?? 'Company'}** — brands: ${brandSummary}`, ``);

  for (const b of (ctx.brands ?? [])) {
    lines.push(`### ${b.name} (${b.prefix})`);
    lines.push(b.description ?? '');
    if (b.products?.length) {
      lines.push(`**Products:** ${b.products.join(' · ')}`);
    }
    if (b.keyTerms && Object.keys(b.keyTerms).length) {
      lines.push(`**Key terms:**`);
      for (const [t, d] of Object.entries(b.keyTerms as Record<string, string>)) {
        lines.push(`- ${t}: ${d}`);
      }
    }
    lines.push(``);
  }

  // ── Cross-brand terms ──
  if (ctx.crossBrandTerms && Object.keys(ctx.crossBrandTerms).length) {
    lines.push(`## Cross-brand terminology`, ``);
    for (const [t, d] of Object.entries(ctx.crossBrandTerms as Record<string, string>)) {
      lines.push(`- **${t}**: ${d}`);
    }
    lines.push(``);
  }

  // ── Internal systems ──
  if (ctx.internalSystems?.length) {
    lines.push(`## Internal systems`, ``);
    for (const s of ctx.internalSystems as Array<{ name: string; description: string }>) {
      lines.push(`- **${s.name}**: ${s.description}`);
    }
    lines.push(``);
  }

  // ── Team ──
  const team = ctx.team;
  if (team) {
    lines.push(`## DT Team`, ``);
    lines.push(`**${team.name ?? 'Digital Transformation Team'}** — managed by ${team.manager ?? 'Geoff Keenan'}`);
    if (team.members?.length) {
      lines.push(`Members: ${(team.members as string[]).join(', ')} — ${team.specialisation ?? 'full generalists'}`);
    }
    lines.push(``);

    if (team.asanaWorkflow) {
      const aw = team.asanaWorkflow;
      lines.push(`### Asana workflow`);
      lines.push(`Workspace: **${aw.workspace}** (GID: \`${aw.workspaceGid}\`)`);
      lines.push(`Main project: **${aw.mainProject}** (GID: \`${aw.mainProjectGid}\`)`);
      if (aw.sections) {
        lines.push(`Sections:`);
        for (const [name, desc] of Object.entries(aw.sections as Record<string, string>)) {
          lines.push(`- **${name}**: ${desc}`);
        }
      }
      if (aw.userGids) {
        lines.push(`User GIDs: ${Object.entries(aw.userGids as Record<string, string>).map(([n, g]) => `${n} = \`${g}\``).join(', ')}`);
      }
      lines.push(``);
    }

    if (team.environments) {
      lines.push(`### PA Environments`);
      for (const [env, desc] of Object.entries(team.environments as Record<string, string>)) {
        lines.push(`- **${env}**: ${desc}`);
      }
      lines.push(``);
    }

    if (team.deploymentPipeline) {
      lines.push(`### Deployment pipeline`);
      lines.push(team.deploymentPipeline, ``);
    }
  }

  // ── Bot architecture ──
  const bot = ctx.botArchitecture;
  if (bot) {
    lines.push(`## Bot architecture`, ``);

    if (bot.internalAgentBots) {
      const ib = bot.internalAgentBots;
      lines.push(`### Internal agent bots — ${ib.platform} on ${ib.channel}`);
      lines.push(`> ${ib.note ?? ''}`);
      lines.push(``);
      lines.push(`**PA connection:** ${ib.connectionToPowerAutomate ?? ''}`);
      if (ib.commonTopics?.length) {
        lines.push(`**Common topics:**`);
        for (const t of ib.commonTopics as string[]) { lines.push(`- ${t}`); }
      }
      lines.push(``);
    }

    if (bot.customerFacingWhatsApp) {
      const wa = bot.customerFacingWhatsApp;
      lines.push(`### Customer WhatsApp — ${wa.platform} (brands: ${(wa.brands as string[]).join(', ')})`);
      lines.push(`- **Outbound:** ${wa.outbound}`);
      lines.push(`- **Inbound:** ${wa.inbound}`);
      if (wa.note) { lines.push(`> ${wa.note}`); }
      lines.push(``);
    }

    if (bot.cognigy?.note) {
      lines.push(`> ⚠️ ${bot.cognigy.note}`, ``);
    }
  }

  // ── Flow conventions ──
  const fc = ctx.flowConventions;
  if (fc) {
    lines.push(`## Flow conventions`, ``);
    if (fc.solutionNaming) { lines.push(`**Solution naming:** ${fc.solutionNaming}`); }
    if (fc.flowNaming)     { lines.push(`**Flow naming:** ${fc.flowNaming}`); }
    if (fc.errorHandling)  { lines.push(`**Error handling:** ${fc.errorHandling}`); }
    if (fc.connectors?.length) {
      lines.push(`**Connectors used:** ${(fc.connectors as string[]).join(', ')}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

function buildCloudIndexSection(workspaceRoot: string): string {
  const idxPath = path.join(workspaceRoot, 'DXT_CLOUD_INDEX.md');
  if (!fs.existsSync(idxPath)) { return ''; }
  try {
    const content = fs.readFileSync(idxPath, 'utf8');
    return `## Cloud Index — all solutions across all environments\n\n${content}\n`;
  } catch { return ''; }
}

export function generateClaudeMd(lib: Library, solutionsRoot: string, workspaceRoot?: string): void {
  const updated = new Date(lib.lastUpdated).toLocaleString();
  const outDir = workspaceRoot ?? solutionsRoot;

  // Top connectors by usage
  const topConnectors = Object.values(lib.connectors)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(c => {
      const topOps = Object.values(c.operations)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(o => `    - ${o.displayName} (${o.count}×)`)
        .join('\n');
      return `- **${c.displayName}** (${c.count} uses)\n${topOps}`;
    })
    .join('\n');

  // Pull a real connectionName example from any connector action in the library
  const connNameExample = (() => {
    for (const conn of Object.values(lib.connectors)) {
      for (const op of Object.values(conn.operations)) {
        const ex = op.examples[0]?.snippet?.inputs?.host?.connectionName;
        if (ex) { return ex; }
      }
    }
    return 'shared_sharepointonline-1';
  })();

  const botSection = (() => {
    if (!lib.botPatterns.length) { return ''; }
    const cards  = lib.botPatterns.filter(p => p.kind === 'AdaptiveCard');
    const calls  = lib.botPatterns.filter(p => p.kind === 'FlowCall');
    const qs     = lib.botPatterns.filter(p => p.kind === 'Question');
    const msgs   = lib.botPatterns.filter(p => p.kind === 'Message');
    const parts: string[] = [`## Bot Topic Patterns`, ``];
    if (cards.length)  { parts.push(`### Adaptive Cards (${cards.length})`, ``, ...cards.slice(0,3).map(c => `- **${c.displayName}** (${c.solution})\n\`\`\`json\n${c.snippet}\n\`\`\``), ``); }
    if (calls.length)  { parts.push(`### Flow Calls (${calls.length})`, ``, ...calls.slice(0,3).map(c => `- **${c.displayName}** (${c.solution})\n\`\`\`yaml\n${c.snippet}\n\`\`\``), ``); }
    if (qs.length)     { parts.push(`### Question Patterns (${qs.length})`, ``, ...qs.slice(0,3).map(q => `- **${q.displayName}** (${q.solution})\n\`\`\`yaml\n${q.snippet}\n\`\`\``), ``); }
    parts.push(
      `### Tips for writing bot topics`,
      ``,
      `1. Variables: \`Topic.VarName\` for topic-scoped, \`Global.VarName\` for cross-topic persistence.`,
      `2. Flow inputs use \`=VariableName\` syntax for dynamic values, plain string for literals.`,
      `3. Always declare \`outputType\` with matching property names to \`output.binding\` keys.`,
      `4. Condition check format: \`=Topic.Var = 'full.enum.path.Value'\` for closed list choices.`,
      `5. Use \`kind: GotoAction\` with \`actionId\` to loop back to a previous step.`,
      ``
    );
    return parts.join('\n');
  })();

  const companySection   = workspaceRoot ? buildCompanySection(workspaceRoot)   : '';
  const cloudIndexSection = workspaceRoot ? buildCloudIndexSection(workspaceRoot) : '';

  const md = `# DXT Power Automate Toolkit — AI Context

> Auto-generated by DXT Power Automate Toolkit on ${updated}
> ${lib.flowsScanned} flows · ${lib.solutionsScanned} solutions · ${lib.topicsScanned} bot topics indexed
> Share this file with teammates — it is automatically synced to SharePoint on each library rebuild.

${companySection}

## Folder structure

\`\`\`
<this folder>/
├── SolutionName/
│   └── Workflows/
│       └── FlowName-{guid}.json   ← flow definitions (edit these)
└── .pa-library.json               ← indexed action library (do not edit)
\`\`\`

## How to read a flow file

Each \`Workflows/*.json\` file has this shape:

\`\`\`json
{
  "properties": {
    "connectionReferences": { ... },
    "definition": {
      "triggers": { "TriggerName": { "type": "...", "inputs": { ... } } },
      "actions":  { "ActionName": { "type": "...", "inputs": { ... }, "runAfter": { ... } } }
    }
  }
}
\`\`\`

Key fields on every action:
- \`type\` — e.g. \`"OpenApiConnection"\`, \`"If"\`, \`"Foreach"\`, \`"Compose"\`, \`"Http"\`
- \`runAfter\` — dependencies: \`{ "PreviousAction": ["Succeeded"] }\`. Empty \`{}\` means run first.
- \`inputs\` — the action's configuration (connector params, expressions, etc.)

For connector actions (\`type: "OpenApiConnection"\`):
\`\`\`json
{
  "type": "OpenApiConnection",
  "inputs": {
    "host": {
      "connectionName": "${connNameExample}",
      "operationId": "GetItems",
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline"
    },
    "parameters": { "dataset": "https://...", "table": "ListName" }
  },
  "runAfter": {}
}
\`\`\`

## PA expression syntax

| Goal | Expression |
|------|-----------|
| Action output field | \`@{outputs('ActionName')?['body']?['field']}\` |
| Full body of action | \`@{body('ActionName')}\` |
| Variable value | \`@{variables('VariableName')}\` |
| Trigger body field | \`@{triggerBody()?['field']}\` |
| Concat strings | \`@{concat(variables('A'), ' ', variables('B'))}\` |
| Current item in loop | \`@{items('ForeachActionName')}\` |
| Condition expression | \`@equals(variables('Status'), 'Active')\` |

Wrap in \`@{...}\` when the expression is part of a string. Use \`@expression\` alone (no braces) when the whole value is an expression.

## Connectors used in this org

${topConnectors}

## Tips when helping with these flows

1. **Check \`.pa-library.json\`** before writing any connector action — it has real JSON snippets from this org's flows with correct \`connectionName\` values.
2. **Match \`connectionName\`** from an existing action in the same flow — don't invent connection names.
3. **Action names** must be unique within a flow, PascalCase, no spaces (underscores ok).
4. **\`runAfter\`** must reference actions that actually exist in the same scope (top-level, or inside the same \`Foreach\`/\`If\` branch).
5. For \`If\` actions: yes-branch actions go in \`actions\`, no-branch in \`else.actions\`.
6. For \`Foreach\` actions: inner actions go in \`actions\`, and \`foreach\` is the array expression.

${cloudIndexSection}
${botSection}`;

  fs.writeFileSync(path.join(outDir, 'CLAUDE.md'), md, 'utf8');
}
