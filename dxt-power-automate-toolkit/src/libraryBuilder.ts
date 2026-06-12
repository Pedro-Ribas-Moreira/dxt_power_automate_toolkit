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

export interface Library {
  lastUpdated: string;
  solutionsScanned: number;
  flowsScanned: number;
  connectors: Record<string, LibraryConnector>;
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

export function buildLibrary(solutionsRoot: string): Library {
  const lib: Library = {
    lastUpdated: new Date().toISOString(),
    solutionsScanned: 0,
    flowsScanned: 0,
    connectors: {}
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

export function generateClaudeMd(lib: Library, solutionsRoot: string): void {
  const updated = new Date(lib.lastUpdated).toLocaleString();

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

  const md = `# Power Automate Solutions — AI Context

> Auto-generated by DXT Power Automate Toolkit on ${updated}
> ${lib.flowsScanned} flows · ${lib.solutionsScanned} solutions indexed

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
`;

  fs.writeFileSync(path.join(solutionsRoot, 'CLAUDE.md'), md, 'utf8');
}
