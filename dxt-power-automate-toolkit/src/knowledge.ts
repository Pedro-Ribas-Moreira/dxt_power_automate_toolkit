// Power Automate knowledge renderer — TS port of dxt-bridge src/context.js
// loadKnowledgeContext(). Reads resources/pa-knowledge.json (official docs
// distilled: expression syntax, limits, patterns, best practices) and renders
// the markdown section embedded in the generated CLAUDE.md.
import * as fs from 'fs';
import * as path from 'path';

export function renderKnowledgeSection(extensionPath: string): string {
  const file = path.join(extensionPath, 'resources', 'pa-knowledge.json');
  if (!fs.existsSync(file)) { return ''; }
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));

    const fnLines: string[] = [];
    for (const [cat, fns] of Object.entries(k.expressions?.commonFunctions || {}) as [string, string[]][]) {
      fnLines.push(`  [${cat}] ${fns.join(' | ')}`);
    }
    const refSyntax = k.expressions?.syntax || '';
    const refItems = (k.expressions?.referencing || []).join('\n  - ');

    const spTrig = k.expressions?.sharepointTrigger;
    const spTrigLines = spTrig ? [
      `  [single item] ${(spTrig.singleItem || []).join(' | ')}`,
      `  [batch]       ${(spTrig.batchTrigger || []).join(' | ')}`,
      `  [odata]       ${(spTrig.odataFilters || []).join(' | ')}`,
    ].join('\n') : '';

    const httpEx = k.expressions?.httpConnector;
    const httpLines = httpEx ? [
      `  [auth]     ${(httpEx.authHeaders || []).join(' | ')}`,
      `  [response] ${(httpEx.responsePatterns || []).join(' | ')}`,
      `  [async]    ${httpEx.asyncPattern || ''}`,
    ].join('\n') : '';

    const dv = k.expressions?.dataverse;
    const dvLines = dv ? [
      `  [trigger] ${(dv.triggerPatterns || []).join(' | ')}`,
      `  [action]  ${(dv.actionPatterns || []).join(' | ')}`,
    ].join('\n') : '';

    const lim = k.limits || {};
    const limLines = [
      `Actions/flow: ${lim.flowDefinition?.actionsPerFlow}`,
      `Apply to each: ${lim.concurrencyAndLoops?.applyToEachItems}, concurrency 1–50`,
      `HTTP timeout: ${lim.timeouts?.outboundSyncRequest}`,
      `Message size: ${lim.dataSize?.messageSize}`,
      `Until: ${lim.concurrencyAndLoops?.untilIterations}`,
    ].join(' | ');

    const patLines = Object.entries(k.patterns || {})
      .map(([name, p]: [string, any]) => `  ${name}: ${(p.description || '').slice(0, 120)}`)
      .join('\n');

    const bpLines = (k.bestPractices || []).map((b: string) => `  - ${b}`).join('\n');

    const org = k.orgSpecific || {};
    const orgLines = Object.entries(org).map(([key, v]) => `  ${key}: ${v}`).join('\n');

    return `Source: ${(k.source || []).join(', ')} (fetched ${k.lastUpdated})

### Expression syntax
${refSyntax}
Reference:
  - ${refItems}
${spTrigLines ? `\n### SharePoint trigger expressions\n${spTrigLines}` : ''}
${httpLines ? `\n### HTTP connector expressions\n${httpLines}` : ''}
${dvLines ? `\n### Dataverse expressions\n${dvLines}` : ''}
### Common functions (syntax: result)
${fnLines.join('\n')}

### Key limits
${limLines}

### Design patterns
${patLines}

### Best practices
${bpLines}

### Org-specific
${orgLines}`;
  } catch { return ''; }
}
