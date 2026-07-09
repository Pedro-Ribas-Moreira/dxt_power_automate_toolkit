// Pure flow-definition tree surgery, shared by the visualizer webview handlers
// and the library panel. Ported from dxt-bridge src/flows.js (insert/copy are
// its superset versions: custom names, extra templates) merged with the
// helpers that previously lived inline in flowVisualizer.ts.
//
// runAfter casing: new links are written as ['SUCCEEDED'] (uppercase), matching
// dxt-bridge's on-disk output and the org building guide. Power Automate
// accepts both casings.
import * as fs from 'fs';
import * as path from 'path';

// ─── Naming ───────────────────────────────────────────────────────────────────

/** Workflow file name → display name ("My-Flow-<GUID>.json" → "My Flow").
 *  Single source of truth: libraryBuilder keys, open-flow resolution and the
 *  visualizer title must all agree on this normalization. */
export function flowDisplayName(fileName: string): string {
  return path.basename(fileName, '.json')
    .replace(/-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i, '')
    .replace(/-/g, ' ')
    .trim();
}

// ─── Tree-traversal helpers ───────────────────────────────────────────────────

export function findActionScope(actions: Record<string, any>, targetName: string): Record<string, any> | null {
  if (actions[targetName]) { return actions; }
  for (const a of Object.values(actions) as any[]) {
    if (a?.actions) { const f = findActionScope(a.actions, targetName); if (f) { return f; } }
    if (a?.else?.actions) { const f = findActionScope(a.else.actions, targetName); if (f) { return f; } }
  }
  return null;
}

export function applyPatchToActions(actions: Record<string, any>, name: string, patch: Record<string, any>): boolean {
  if (actions[name]) {
    Object.assign(actions[name], patch);
    return true;
  }
  for (const a of Object.values(actions) as any[]) {
    if (a?.actions && applyPatchToActions(a.actions, name, patch)) { return true; }
    if (a?.else?.actions && applyPatchToActions(a.else.actions, name, patch)) { return true; }
  }
  return false;
}

export function reconnectRunAfter(actions: Record<string, any>, deletedName: string, deletedRunAfter: Record<string, string[]>): void {
  for (const action of Object.values(actions) as any[]) {
    if (action?.runAfter?.[deletedName]) {
      delete action.runAfter[deletedName];
      // Inherit the deleted action's own predecessors
      for (const [pred, statuses] of Object.entries(deletedRunAfter)) {
        action.runAfter[pred] = statuses;
      }
    }
    if (action?.actions) { reconnectRunAfter(action.actions, deletedName, deletedRunAfter); }
    if (action?.else?.actions) { reconnectRunAfter(action.else.actions, deletedName, deletedRunAfter); }
  }
}

export function collectAllActionNames(actions: Record<string, any>, out = new Set<string>()): Set<string> {
  for (const [name, a] of Object.entries(actions) as [string, any][]) {
    out.add(name);
    if (a?.actions) { collectAllActionNames(a.actions, out); }
    if (a?.else?.actions) { collectAllActionNames(a.else.actions, out); }
  }
  return out;
}

// ─── File-level operations ────────────────────────────────────────────────────

function readFlowFile(flowPath: string): { raw: any; def: any } {
  const raw = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const def = raw.properties?.definition || raw.definition || raw;
  return { raw, def };
}

function writeFlowFile(flowPath: string, raw: any): void {
  fs.writeFileSync(flowPath, JSON.stringify(raw, null, 2), 'utf8');
}

export function patchActionInFlow(flowPath: string, actionName: string, patch: Record<string, any>): void {
  const { raw, def } = readFlowFile(flowPath);
  if (!applyPatchToActions(def.actions || {}, actionName, patch)) {
    throw new Error(`Action "${actionName}" not found in flow`);
  }
  writeFlowFile(flowPath, raw);
}

export function deleteActionFromFlow(flowPath: string, actionName: string): void {
  const { raw, def } = readFlowFile(flowPath);
  const scope = findActionScope(def.actions || {}, actionName);
  if (!scope?.[actionName]) { throw new Error(`Action "${actionName}" not found`); }
  const deletedRunAfter: Record<string, string[]> = scope[actionName].runAfter || {};
  delete scope[actionName];
  reconnectRunAfter(def.actions || {}, actionName, deletedRunAfter);
  writeFlowFile(flowPath, raw);
}

/** Overwrite the definition's triggers/actions with edited copies (raw-JSON
 *  editor and undo/redo both save through this). */
export function saveFlowJson(flowPath: string, triggers?: Record<string, any>, actions?: Record<string, any>): void {
  const { raw, def } = readFlowFile(flowPath);
  if (triggers && typeof triggers === 'object') { def.triggers = triggers; }
  if (actions && typeof actions === 'object') { def.actions = actions; }
  writeFlowFile(flowPath, raw);
}

export function insertActionInFlow(
  flowPath: string,
  predecessorName: string | null,
  successorName: string | null,
  actionType: string,
  parentAction?: string,
  branch?: string,
  customName?: string
): string {
  const { raw, def } = readFlowFile(flowPath);

  const allNames = collectAllActionNames(def.actions || {});
  let newName: string;
  if (customName) {
    const base = customName.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '') || actionType;
    newName = base;
    let c = 2;
    while (allNames.has(newName)) { newName = `${base}_${c++}`; }
  } else {
    let counter = 1;
    while (allNames.has(`${actionType}_${counter}`)) { counter++; }
    newName = `${actionType}_${counter}`;
  }

  const runAfter: Record<string, string[]> = predecessorName ? { [predecessorName]: ['SUCCEEDED'] } : {};
  const templates: Record<string, any> = {
    Compose:                { type: 'Compose', inputs: '', runAfter },
    InitializeVariable:     { type: 'InitializeVariable', inputs: { variables: [{ name: 'NewVariable', type: 'string', value: '' }] }, runAfter },
    SetVariable:            { type: 'SetVariable', inputs: { name: '', value: '' }, runAfter },
    AppendToStringVariable: { type: 'AppendToStringVariable', inputs: { name: '', value: '' }, runAfter },
    IncrementVariable:      { type: 'IncrementVariable', inputs: { name: '', value: 1 }, runAfter },
    If:                     { type: 'If', expression: { equals: ['', ''] }, actions: {}, else: { actions: {} }, runAfter },
    Foreach:                { type: 'Foreach', foreach: '', actions: {}, runAfter },
    Scope:                  { type: 'Scope', actions: {}, runAfter },
    Until:                  { type: 'Until', expression: '', limit: { count: 60, timeout: 'PT1H' }, actions: {}, runAfter },
    ParseJson:              { type: 'ParseJson', inputs: { content: '', schema: { type: 'object', properties: {} } }, runAfter },
    Select:                 { type: 'Select', inputs: { from: '', select: {} }, runAfter },
    Query:                  { type: 'Query', inputs: { from: '', where: '' }, runAfter },
    Http:                   { type: 'Http', inputs: { method: 'GET', uri: '' }, runAfter },
    Response:               { type: 'Response', kind: 'Http', inputs: { statusCode: 200, body: '' }, runAfter },
    Terminate:              { type: 'Terminate', inputs: { runStatus: 'Succeeded' }, runAfter },
  };
  const newAction = templates[actionType] ?? { type: actionType, inputs: {}, runAfter };

  const scope = resolveInsertScope(def, predecessorName, successorName, parentAction, branch);
  scope[newName] = newAction;
  rewireSuccessor(scope, newName, predecessorName, successorName);

  writeFlowFile(flowPath, raw);
  return newName;
}

export function copyActionInFlow(
  flowPath: string,
  sourceName: string,
  predecessorName: string | null,
  successorName: string | null,
  parentAction?: string,
  branch?: string
): string {
  const { raw, def } = readFlowFile(flowPath);

  const sourceScope = findActionScope(def.actions || {}, sourceName);
  if (!sourceScope?.[sourceName]) { throw new Error(`Action "${sourceName}" not found`); }

  const allNames = collectAllActionNames(def.actions || {});
  const base = sourceName.replace(/_Copy_\d+$/, '');
  let newName = `${base}_Copy_1`;
  let c = 2;
  while (allNames.has(newName)) { newName = `${base}_Copy_${c++}`; }
  allNames.add(newName);

  const copiedAction = deepCopyActionSubtree(sourceScope[sourceName], allNames);
  copiedAction.runAfter = predecessorName ? { [predecessorName]: ['SUCCEEDED'] } : {};

  const scope = resolveInsertScope(def, predecessorName, successorName, parentAction, branch);
  scope[newName] = copiedAction;
  rewireSuccessor(scope, newName, predecessorName, successorName);

  writeFlowFile(flowPath, raw);
  return newName;
}

// ─── Insert/copy shared internals ─────────────────────────────────────────────

function resolveInsertScope(
  def: any,
  predecessorName: string | null,
  successorName: string | null,
  parentAction?: string,
  branch?: string
): Record<string, any> {
  let scope: Record<string, any> | null = null;
  if (predecessorName || successorName) {
    scope = findActionScope(def.actions || {}, (successorName ?? predecessorName)!);
  } else if (parentAction && branch) {
    // Empty branch case — navigate directly to the parent action's branch
    const parentScope = findActionScope(def.actions || {}, parentAction);
    const parent = parentScope?.[parentAction];
    if (!parent) { throw new Error(`Parent action "${parentAction}" not found`); }
    if (branch === 'yes' || branch === 'foreach' || branch === 'scope') {
      if (!parent.actions) { parent.actions = {}; }
      scope = parent.actions;
    } else if (branch === 'no') {
      if (!parent.else) { parent.else = { actions: {} }; }
      if (!parent.else.actions) { parent.else.actions = {}; }
      scope = parent.else.actions;
    }
  } else {
    scope = def.actions || {};
  }
  if (!scope) { throw new Error('Cannot find insertion scope'); }
  return scope;
}

/** Redirect the successor's runAfter from predecessor → the newly inserted action. */
function rewireSuccessor(
  scope: Record<string, any>,
  newName: string,
  predecessorName: string | null,
  successorName: string | null
): void {
  if (successorName && scope[successorName]) {
    const ra: Record<string, string[]> = scope[successorName].runAfter ?? {};
    if (predecessorName && ra[predecessorName]) {
      ra[newName] = ra[predecessorName];
      delete ra[predecessorName];
    } else if (!predecessorName) {
      ra[newName] = ['SUCCEEDED'];
    }
    scope[successorName].runAfter = ra;
  }
}

function renameActionsSubtree(actions: Record<string, any>, allNames: Set<string>): Record<string, any> {
  const renameMap: Record<string, string> = {};
  for (const name of Object.keys(actions)) {
    const base = name.replace(/_Copy_\d+$/, '');
    let n = `${base}_Copy_1`;
    let c = 2;
    while (allNames.has(n)) { n = `${base}_Copy_${c++}`; }
    renameMap[name] = n;
    allNames.add(n);
  }
  const result: Record<string, any> = {};
  for (const [oldName, action] of Object.entries(actions) as [string, any][]) {
    const newName = renameMap[oldName];
    const copy = deepCopyActionSubtree(action, allNames);
    copy.runAfter = {};
    for (const [pred, statuses] of Object.entries(action.runAfter || {})) {
      copy.runAfter[renameMap[pred] ?? pred] = statuses;
    }
    result[newName] = copy;
  }
  return result;
}

function deepCopyActionSubtree(action: any, allNames: Set<string>): any {
  const copy = JSON.parse(JSON.stringify(action));
  copy.runAfter = {};
  if (copy.actions) { copy.actions = renameActionsSubtree(copy.actions, allNames); }
  if (copy.else?.actions) { copy.else.actions = renameActionsSubtree(copy.else.actions, allNames); }
  return copy;
}
