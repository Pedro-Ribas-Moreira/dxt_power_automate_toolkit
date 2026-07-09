// Asana REST client (ported from dxt-bridge src/asana.js). PAT auth via
// VS Code SecretStorage — the token never touches workspace files, logs, or
// SharePoint. In-memory TTL caches mirror dxt-bridge (tasks 5 min, stories
// 90 s, sections 30 min) to stay well inside Asana's 150 req/min rate limit.
import * as vscode from 'vscode';
import { loadCompanyContext } from './companyContext';

const PAT_KEY = 'dxt-asana-pat';
const BASE = 'https://app.asana.com/api/1.0';

// DT team defaults — overridden by company-context.json team.asanaWorkflow
const DEFAULT_WORKSPACE_GID = '13428659628627';
const DEFAULT_PROJECT_GID = '1204978926889787';

// Canonical field set — superset of every caller's needs; always fetch this.
const TASK_FIELDS =
  'gid,name,due_on,completed,notes,projects.name,permalink_url,num_stories,' +
  'assignee.gid,assignee.name,memberships.section.name,memberships.project.gid,' +
  'tags.name,custom_fields.name,custom_fields.display_value';

const SECTION_TASK_FIELDS =
  'gid,name,due_on,completed,notes,tags.name,assignee.gid,assignee.name,projects.name,permalink_url,num_stories';

const TASK_TTL = 5 * 60 * 1000;
const STORY_TTL = 90 * 1000;
const SEC_TTL = 30 * 60 * 1000;
const SINGLE_TASK_TTL = 60 * 1000;

export type Urgency = 'overdue' | 'this-week' | 'upcoming' | 'no-date';
export type AssigneeFilter = 'me' | 'unassigned' | 'me_or_unassigned' | 'all';

export interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  assignee: { gid: string; name: string } | null;
  due_on: string | null;
  notes: string;
  tags: string[];
  projects: string[];
  permalink_url: string;
  num_stories: number;
  urgency: Urgency;
}

export interface AsanaStory {
  gid: string;
  created_at: string;
  type: string;
  resource_subtype?: string;
  text: string;
  created_by: string;
}

export interface AsanaSection {
  gid: string;
  name: string;
}

let _context: vscode.ExtensionContext | undefined;
let _workspaceRoot: string | undefined;

export function initAsana(context: vscode.ExtensionContext, workspaceRoot?: string): void {
  _context = context;
  _workspaceRoot = workspaceRoot;
}

export async function getAsanaPat(): Promise<string | undefined> {
  return _context?.secrets.get(PAT_KEY);
}

export async function setAsanaPat(pat: string): Promise<void> {
  await _context?.secrets.store(PAT_KEY, pat);
  invalidateCache();
  await vscode.commands.executeCommand('setContext', 'dxt-power-automate.asanaConfigured', !!pat);
}

export async function updateAsanaConfiguredContext(): Promise<boolean> {
  const configured = !!(await getAsanaPat());
  await vscode.commands.executeCommand('setContext', 'dxt-power-automate.asanaConfigured', configured);
  return configured;
}

export function getAsanaConfig(): { workspaceGid: string; projectGid: string; sections: Record<string, string> } {
  const aw = _workspaceRoot ? loadCompanyContext(_workspaceRoot)?.team?.asanaWorkflow : undefined;
  return {
    workspaceGid: aw?.workspaceGid || DEFAULT_WORKSPACE_GID,
    projectGid: aw?.mainProjectGid || DEFAULT_PROJECT_GID,
    sections: aw?.sections ?? {},
  };
}

/** Accepts a bare GID or any Asana task URL; returns the GID or null. */
export function extractTaskGid(input: string): string | null {
  const s = (input || '').trim();
  if (/^\d{8,}$/.test(s)) { return s; }
  const m = s.match(/\/(\d{8,})(?:\/|$)/);
  return m ? m[1] : null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function requirePat(): Promise<string> {
  const pat = await getAsanaPat();
  if (!pat) { throw new Error('Asana not configured — run "Asana: Set Personal Access Token"'); }
  return pat;
}

async function asanaGet(endpoint: string): Promise<any> {
  const pat = await requirePat();
  const r = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' },
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(body?.errors?.[0]?.message || `Asana API error: HTTP ${r.status}`);
  }
  return body.data ?? [];
}

async function asanaPost(endpoint: string, data: any): Promise<any> {
  const pat = await requirePat();
  const r = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(body?.errors?.[0]?.message || `Asana API error: HTTP ${r.status}`);
  }
  return body.data;
}

// ── Caches ───────────────────────────────────────────────────────────────────

let _userGid: string | null = null;
const _taskListCache = { data: null as any[] | null, at: 0 };
const _storyCache: Record<string, { data: AsanaStory[]; at: number }> = {};
const _sectionCache = { data: null as AsanaSection[] | null, at: 0 };
const _taskCache: Record<string, { data: AsanaTask; at: number }> = {};

export function invalidateCache(): void {
  _taskListCache.data = null;
  _taskListCache.at = 0;
  _sectionCache.data = null;
  _sectionCache.at = 0;
  for (const k of Object.keys(_storyCache)) { delete _storyCache[k]; }
  for (const k of Object.keys(_taskCache)) { delete _taskCache[k]; }
  _userGid = null; // a PAT change must pick up the new user
}

export async function getCurrentUserGid(): Promise<string | null> {
  if (_userGid) { return _userGid; }
  try {
    const me = await asanaGet('/users/me?opt_fields=gid');
    _userGid = me?.gid ?? null;
  } catch { _userGid = null; }
  return _userGid;
}

// ── Task shaping (mirrors dxt-bridge assistant.js my-tasks) ──────────────────

function shapeTask(t: any): AsanaTask {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);
  let urgency: Urgency = 'no-date';
  if (t.due_on) {
    const due = new Date(t.due_on + 'T00:00:00');
    if (due < today) { urgency = 'overdue'; }
    else if (due < nextWeek) { urgency = 'this-week'; }
    else { urgency = 'upcoming'; }
  }
  return {
    gid: t.gid,
    name: t.name,
    completed: !!t.completed,
    assignee: t.assignee ? { gid: t.assignee.gid, name: t.assignee.name } : null,
    due_on: t.due_on || null,
    notes: (t.notes || '').slice(0, 500),
    tags: (t.tags || []).map((tg: any) => tg.name).filter(Boolean),
    projects: (t.projects || []).map((p: any) => p.name).filter(Boolean),
    permalink_url: t.permalink_url,
    num_stories: t.num_stories || 0,
    urgency,
  };
}

const URGENCY_ORDER: Record<Urgency, number> = { overdue: 0, 'this-week': 1, upcoming: 2, 'no-date': 3 };

export function sortByUrgency(tasks: AsanaTask[]): AsanaTask[] {
  return [...tasks].sort((a, b) => {
    const diff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (diff !== 0) { return diff; }
    if (a.due_on && b.due_on) { return a.due_on.localeCompare(b.due_on); }
    return 0;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchMyTasks(): Promise<AsanaTask[]> {
  const now = Date.now();
  if (_taskListCache.data && now - _taskListCache.at < TASK_TTL) {
    return sortByUrgency(_taskListCache.data.map(shapeTask));
  }
  const { workspaceGid } = getAsanaConfig();
  const data = await asanaGet(
    `/tasks?assignee=me&workspace=${workspaceGid}&completed_since=now&limit=100&opt_fields=${TASK_FIELDS}`
  );
  _taskListCache.data = data;
  _taskListCache.at = Date.now();
  return sortByUrgency(data.map(shapeTask));
}

export async function fetchProjectSections(): Promise<AsanaSection[]> {
  const now = Date.now();
  if (_sectionCache.data && now - _sectionCache.at < SEC_TTL) { return _sectionCache.data; }
  const { projectGid } = getAsanaConfig();
  const data = await asanaGet(`/projects/${projectGid}/sections?opt_fields=gid,name&limit=100`);
  _sectionCache.data = (data || []).map((s: any) => ({ gid: s.gid, name: s.name }));
  _sectionCache.at = Date.now();
  return _sectionCache.data!;
}

export async function fetchSectionTasks(sectionGid: string, filter: AssigneeFilter = 'me_or_unassigned'): Promise<AsanaTask[]> {
  const data = await asanaGet(`/sections/${sectionGid}/tasks?opt_fields=${SECTION_TASK_FIELDS}&limit=100`);
  let tasks: any[] = (data || []).filter((t: any) => !t.completed);
  if (filter !== 'all') {
    const myGid = (filter === 'me' || filter === 'me_or_unassigned') ? await getCurrentUserGid() : null;
    tasks = tasks.filter((t: any) => {
      if (filter === 'me') { return t.assignee?.gid === myGid; }
      if (filter === 'unassigned') { return !t.assignee; }
      return !t.assignee || t.assignee.gid === myGid; // me_or_unassigned
    });
  }
  return sortByUrgency(tasks.map(shapeTask));
}

export async function fetchTask(gid: string): Promise<AsanaTask> {
  const now = Date.now();
  const cached = _taskCache[gid];
  if (cached && now - cached.at < SINGLE_TASK_TTL) { return cached.data; }
  const data = await asanaGet(`/tasks/${gid}?opt_fields=${TASK_FIELDS}`);
  const task = shapeTask(data);
  _taskCache[gid] = { data: task, at: Date.now() };
  return task;
}

export async function fetchTaskStories(gid: string): Promise<AsanaStory[]> {
  const now = Date.now();
  const cached = _storyCache[gid];
  if (cached && now - cached.at < STORY_TTL) { return cached.data; }
  const data = await asanaGet(`/tasks/${gid}/stories?opt_fields=gid,created_at,type,resource_subtype,text,created_by.name&limit=100`);
  const stories: AsanaStory[] = (data || []).map((s: any) => ({
    gid: s.gid,
    created_at: s.created_at,
    type: s.type,
    resource_subtype: s.resource_subtype,
    text: s.text || '',
    created_by: s.created_by?.name || '',
  }));
  _storyCache[gid] = { data: stories, at: Date.now() };
  return stories;
}

export async function addComment(gid: string, text: string): Promise<void> {
  await asanaPost(`/tasks/${gid}/stories`, { text });
  delete _storyCache[gid];
}

export async function createTask(opts: { name: string; notes?: string; sectionGid?: string }): Promise<{ gid: string; name: string; permalink_url: string }> {
  const { workspaceGid, projectGid } = getAsanaConfig();
  const data: any = { name: opts.name.trim(), workspace: workspaceGid, projects: [projectGid] };
  if (opts.notes?.trim()) { data.notes = opts.notes.trim(); }
  if (opts.sectionGid) { data.memberships = [{ project: projectGid, section: opts.sectionGid }]; }
  const created = await asanaPost('/tasks', data);
  invalidateCache(); // so the tree picks up the new task
  return { gid: created.gid, name: created.name, permalink_url: created.permalink_url };
}
