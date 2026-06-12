import * as fs from 'fs';
import * as path from 'path';

// ─── CSV parser (no external deps) ────────────────────────────────────────────

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { return []; }

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] ?? '').trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ''));
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
    else if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ─── SharePoint Get items response format ────────────────────────────────────

function csvRowsToSpBody(rows: Record<string, string>[]): any {
  const value = rows.map((row, i) => {
    const item: Record<string, any> = {
      '@odata.etag': `"${i + 1}"`,
      ItemInternalId: String(i + 1),
      ID: i + 1,
    };
    for (const [k, v] of Object.entries(row)) {
      const num = Number(v);
      item[k] = !isNaN(num) && v !== '' ? num : v;
    }
    return item;
  });
  return { body: { value } };
}

// ─── JSON input detection ─────────────────────────────────────────────────────

export type InputFormat = 'pa-body' | 'pa-value-array' | 'item-array' | 'unknown';

export function detectFormat(data: any): InputFormat {
  if (data?.body?.value && Array.isArray(data.body.value)) { return 'pa-body'; }
  if (data?.value && Array.isArray(data.value))            { return 'pa-value-array'; }
  if (Array.isArray(data))                                 { return 'item-array'; }
  return 'unknown';
}

export function normaliseToSpBody(raw: any): any {
  const fmt = detectFormat(raw);
  if (fmt === 'pa-body')       { return raw; }
  if (fmt === 'pa-value-array') { return { body: raw }; }
  if (fmt === 'item-array')    { return { body: { value: raw } }; }
  // Single object — wrap as single-item list
  return { body: { value: [raw] } };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function importFromJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

export function importFromCsv(filePath: string): any {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(raw);
  return csvRowsToSpBody(rows);
}

export function importFromClipboardText(text: string): any | null {
  text = text.trim();
  // Try JSON first
  try { return JSON.parse(text); } catch {}
  // Try CSV
  if (text.includes(',') && text.includes('\n')) {
    const rows = parseCsv(text);
    if (rows.length) { return csvRowsToSpBody(rows); }
  }
  return null;
}

// ─── Mock data file management ────────────────────────────────────────────────

export function getMockDataPath(solutionDir: string): string {
  return path.join(path.dirname(solutionDir), 'mock-data.json');
}

export function loadMockData(mockPath: string): Record<string, any> {
  if (!fs.existsSync(mockPath)) { return {}; }
  try { return JSON.parse(fs.readFileSync(mockPath, 'utf8')); }
  catch { return {}; }
}

export function saveMockEntry(mockPath: string, actionName: string, data: any): void {
  const existing = loadMockData(mockPath);
  existing[actionName] = normaliseToSpBody(data);
  fs.writeFileSync(mockPath, JSON.stringify(existing, null, 2), 'utf8');
}

export function listMockActions(mockPath: string): string[] {
  return Object.keys(loadMockData(mockPath));
}

// ─── Action scanner ───────────────────────────────────────────────────────────

export interface FlowAction {
  name: string;
  type: string;
  displayName: string;
}

export function listApiActions(flowPath: string): FlowAction[] {
  try {
    const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    const def = flow.properties?.definition || flow.definition || flow;
    const actions = def.actions || {};
    const result: FlowAction[] = [];
    collectActions(actions, result);
    return result;
  } catch { return []; }
}

function collectActions(actions: Record<string, any>, result: FlowAction[]): void {
  for (const [name, action] of Object.entries(actions)) {
    const type: string = action.type || '';
    if (['ApiConnection', 'OpenApiConnection', 'Http'].includes(type)) {
      result.push({ name, type, displayName: name.replace(/_/g, ' ') });
    }
    if (action.actions) { collectActions(action.actions, result); }
    if (action.else?.actions) { collectActions(action.else.actions, result); }
  }
}
