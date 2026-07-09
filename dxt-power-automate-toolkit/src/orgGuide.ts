// Org building guide — verbatim from dxt-bridge src/claude.js (ORG_BUILDING_GUIDE).
// Kept as a TS constant (not company-context.json) because it contains markdown
// and code samples, and it should version with the extension. Included in the
// generated CLAUDE.md so Claude Code applies these rules when editing flows.

export const ORG_BUILDING_GUIDE = `## Building flows and solutions at Yuno Energy Group

### Naming conventions (ALWAYS apply these)
Solutions:  BrandPrefix_Product_Department_DescriptiveName
  e.g.  PPP_Elec_Retention_MarketMessaging  |  YE_Gas_CX_NPS  |  PPP_Onboarding_CustomerSetup
  Brands:      PPP (PrepayPower), YE (Yuno Energy), YEH (Yuno Energy Heat), FIR (Firmus)
  Products:    Elec, Gas, Oil, BB (Broadband), DualFuel — omit if cross-product
  Departments: CX, Retention, COT, Sales, Onboarding, Marketing, Billing, HR, Finance, SupportOps, DTX

Flows:  Verb + subject + trigger/event type
  e.g.  "Process MM110 Debt Alert"  |  "Send NPS Survey on Case Close"  |  "Sync HappyFox Ticket on Update"
  Action verbs: Process, Send, Sync, Get, Create, Update, Notify, Log, Generate, Validate

### Deployment pipeline
Development (DTA Dev) → Test (DTA Test) → Production (DTA Production)
Export with: pac solution export --name SolutionName --path ./export --managed false
Import with: pac solution import --path ./export/SolutionName.zip
Always export unmanaged to Dev/Test, managed to Prod.

### Mandatory patterns for every production flow
1. Wrap all main logic in a Scope named "Try"
2. Add a second Scope named "Catch" with runAfter: {"Try":["Failed","TimedOut","Skipped"]}
3. Inside Catch: post a Teams message to the DT team channel with:
   - Flow name: @{workflow().tags.flowDisplayName}
   - Error: @{actions('Try').error.message}  (or @{outputs('Try')})
   - Run link: @{concat('https://make.powerautomate.com/environments/', workflow().tags.environmentName, '/flows/', workflow().name, '/runs/', workflow().run.name)}
4. For HTTP-triggered flows: return a Response action on EVERY code path — caller times out after 120 s
5. Terminate actions should always set runStatus to "Failed" with a meaningful error message, not "Succeeded"

### Stack-specific connectors and systems
- Email:         office365 connector | operation: SendEmailV2
- Teams alerts:  microsoftteams connector | operation: PostMessageToConversation (use channel, not chat)
- SQL Server:    sql connector | server: ppp-prod-sqlr01 | use ExecuteStoredProcedure or ExecuteQuery
- HappyFox:     HTTP connector | base URL from KV; GET /tickets, POST /tickets, PUT /tickets/{id}
- LivePerson:   HTTP connector | LP Messaging API; work via webhook trigger or HTTP polling
- 8x8 / IVR:    HTTP connector or webhook; coordinate with Barry Hennigan for IVR config
- SharePoint:   sharepointonline connector
- Dataverse:    commondataserviceforapps connector for Copilot Studio bots and model-driven apps
- Key Vault:    keyvault connector | use GetSecret to retrieve API keys — NEVER hardcode secrets in flows
- Copilot bots: Managed via botcomponent solution files; topics stored as YAML in botcomponents/

### When asked to help design or build a flow — always follow this process
1. Clarify the trigger: Scheduled? HTTP endpoint? SharePoint event? Teams button? Dataverse record change?
2. Clarify inputs: What data comes in? (body schema, record fields, schedule parameters)
3. Clarify outputs/side-effects: Email? SQL write? SharePoint update? Teams notification? HTTP response?
4. Draft the structure: Trigger → Initialize Variables → Try scope (main logic) → Catch scope (error handling)
5. Apply naming conventions to the flow and any variables/actions
6. Write the actual flow JSON if the user is working inside a solution folder
7. Flag any throttling risks (Apply to each without concurrency control, large HTTP payloads, etc.)

### Connection reference naming (used inside flow JSON)
Connection references follow the pattern: shared_connectorname_GUID or the solution-prefixed name.
When writing raw JSON for a new flow, copy the connectionReferenceName from an existing flow in the same solution rather than guessing — use the Grep tool to find it.

### Flow JSON schema — modern Power Automate standards (ALWAYS follow these when writing or editing flow JSON)

These rules match what Power Automate's modern designer exports. Deviating from them causes classic-view rendering, import errors, or broken action wiring.

**runAfter status values — UPPERCASE only:**
  ✅ "runAfter": { "ActionName": ["SUCCEEDED"] }
  ✅ Other valid values: "FAILED", "SKIPPED", "TIMEDOUT"
  ❌ Never write: "Succeeded", "Failed", "Skipped", "TimedOut" (mixed case breaks modern runtime)

**Variable types — lowercase only:**
  ✅ "type": "string"  |  "integer"  |  "float"  |  "boolean"  |  "array"  |  "object"
  ❌ Never write: "String", "Integer", "Float", "Boolean", "Array", "Object"

**Trigger schema — always include required array:**
  ✅ "inputs": { "schema": { "type": "object", "properties": {}, "required": [] } }
  ❌ Never omit "required": [] from the trigger schema object

**Definition structure — clean, no extras:**
  ✅ definition keys in order: $schema, contentVersion, parameters, triggers, actions
  ❌ Never add "outputs": {} to the definition — Power Automate does not include it
  ❌ Never add "metadata": { "defaultToEmbeddedConnections": true } to the definition level

**Expression syntax — when the whole value is an expression:**
  ✅ "@outputs('ActionName')"          — direct expression syntax
  ✅ "@variables('VarName')"
  ✅ "some text @{variables('VarName')} more text"  — @{} only for interpolation inside strings
  ❌ Never use "@{outputs('X')}" as the entire value — @{} coerces to string and breaks non-string types

**Workflow metadata XML (customizations.xml <Workflow> entry / json.data.xml) — Active state:**
  ✅ <StateCode>1</StateCode>    (Active — enables new designer and allows running)
  ✅ <StatusCode>2</StatusCode>  (Active)
  ✅ <OnDemand>0</OnDemand>      (0 for Button/manual trigger flows)
  ✅ <IntroducedVersion>1.0.0.0</IntroducedVersion>
  ❌ StateCode 0 / StatusCode 1 = Draft — flow won't appear in modern designer

**Field order inside action objects (match PA export order):**
  type → inputs → runAfter → metadata (operationMetadataId is optional; omit if not propagating from source)`;
