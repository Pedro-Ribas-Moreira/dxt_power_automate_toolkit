import { getTokenForScopes } from './sharepoint';
import { info, error as logError } from './log';

const PA_SCOPES = ['https://service.flow.microsoft.com/.default'];
const PA_BASE   = 'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple';
const API_VER   = 'api-version=2016-11-01';

export interface PaEnvironment {
  name: string;        // internal name used in API calls, e.g. "Default-abc123"
  displayName: string;
  domainName: string;  // e.g. "prepaypower" from the org URL
}

export interface FlowRun {
  id: string;          // run ID (GUID)
  status: 'Succeeded' | 'Failed' | 'Running' | 'Cancelled' | string;
  startTime: string;
  endTime?: string;
  triggerName: string;
  error?: { code: string; message: string };
}

export interface FlowRunAction {
  name: string;
  displayName?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  error?: { code: string; message: string };
}

export interface FlowRunDetail extends FlowRun {
  actions: FlowRunAction[];
}

async function paGet<T>(path: string): Promise<T> {
  const token = await getTokenForScopes(PA_SCOPES);
  const url = `${PA_BASE}${path}${path.includes('?') ? '&' : '?'}${API_VER}`;
  info(`PA API: GET ${path}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    logError(`PA API ${path} → ${res.status}: ${body}`);
    throw new Error(`PA API failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Lists all Power Automate environments the user has access to. */
export async function listPaEnvironments(): Promise<PaEnvironment[]> {
  info('PA API: listing environments…');
  const res = await paGet<{ value: Array<{ name: string; properties: { displayName: string; linkedEnvironmentMetadata?: { domainName: string } } }> }>(
    '/environments'
  );
  const envs = res.value.map(e => ({
    name: e.name,
    displayName: e.properties.displayName,
    domainName: e.properties.linkedEnvironmentMetadata?.domainName ?? '',
  }));
  info(`PA API: found ${envs.length} environment(s): ${envs.map(e => e.displayName).join(', ')}`);
  return envs;
}

/** Match a pac environment URL to a PA API environment name. */
export async function resolveEnvName(environmentUrl: string): Promise<string | undefined> {
  info(`PA API: resolving env name for ${environmentUrl}…`);
  const envs = await listPaEnvironments();
  // The env URL looks like https://orgname.crm4.dynamics.com/
  const domainMatch = environmentUrl.match(/https?:\/\/([^.]+)\./);
  const domain = domainMatch?.[1]?.toLowerCase();
  const matched = envs.find(e => e.domainName.toLowerCase() === domain || e.name.toLowerCase().includes(domain ?? ''));
  if (matched) {
    info(`PA API: matched "${environmentUrl}" → "${matched.name}" (${matched.displayName})`);
  } else {
    info(`PA API: no match found for "${environmentUrl}" — tried domain "${domain}"`);
    info(`PA API: available domains: ${envs.map(e => e.domainName).join(', ')}`);
  }
  return matched?.name;
}


/** Get recent runs for a specific flow. */
export async function getFlowRuns(envName: string, flowId: string, top = 20): Promise<FlowRun[]> {
  info(`PA API: getting runs for flow ${flowId} in env ${envName}…`);
  const res = await paGet<{
    value: Array<{
      name: string;
      properties: {
        status: string;
        startTime: string;
        endTime?: string;
        trigger?: { name: string };
        error?: { code: string; message: string };
      };
    }>;
  }>(`/environments/${envName}/flows/${flowId}/runs?$top=${top}`);

  const runs: FlowRun[] = res.value.map(r => ({
    id: r.name,
    status: r.properties.status,
    startTime: r.properties.startTime,
    endTime: r.properties.endTime,
    triggerName: r.properties.trigger?.name ?? 'Unknown',
    error: r.properties.error,
  }));

  info(`PA API: found ${runs.length} run(s) — ${runs.filter(r => r.status === 'Succeeded').length} succeeded, ${runs.filter(r => r.status === 'Failed').length} failed`);
  for (const r of runs) {
    const dur = r.endTime ? durationLabel(r.startTime, r.endTime) : '…';
    info(`  ${statusIcon(r.status)} ${r.status.padEnd(10)} ${timeAgo(r.startTime).padEnd(16)} ${dur}${r.error ? ` — ${r.error.message}` : ''}`);
  }
  return runs;
}

/** Get full run details including per-action status and errors. */
export async function getFlowRunDetail(envName: string, flowId: string, runId: string): Promise<FlowRunDetail> {
  info(`PA API: getting run detail ${runId}…`);
  const run = await paGet<{
    name: string;
    properties: {
      status: string;
      startTime: string;
      endTime?: string;
      trigger?: { name: string };
      error?: { code: string; message: string };
      actions?: Record<string, {
        name?: string;
        status: string;
        startTime?: string;
        endTime?: string;
        error?: { code: string; message: string };
      }>;
    };
  }>(`/environments/${envName}/flows/${flowId}/runs/${runId}`);

  const actions: FlowRunAction[] = Object.entries(run.properties.actions ?? {}).map(([key, a]) => ({
    name: key,
    displayName: a.name ?? key,
    status: a.status,
    startTime: a.startTime,
    endTime: a.endTime,
    error: a.error,
  }));

  const failedActions = actions.filter(a => a.status === 'Failed');
  info(`PA API: run ${runId} — ${actions.length} action(s), ${failedActions.length} failed`);
  for (const a of failedActions) {
    info(`  ❌ ${a.name}: ${a.error?.message ?? 'no error message'}`);
  }

  return {
    id: run.name,
    status: run.properties.status,
    startTime: run.properties.startTime,
    endTime: run.properties.endTime,
    triggerName: run.properties.trigger?.name ?? 'Unknown',
    error: run.properties.error,
    actions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function statusIcon(status: string): string {
  switch (status) {
    case 'Succeeded': return '✅';
    case 'Failed':    return '❌';
    case 'Running':   return '⏳';
    case 'Cancelled': return '⛔';
    default:          return '❓';
  }
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   { return 'just now'; }
  if (m < 60)  { return `${m}m ago`; }
  const h = Math.floor(m / 60);
  if (h < 24)  { return `${h}h ago`; }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function durationLabel(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000)   { return `${ms}ms`; }
  if (ms < 60000)  { return `${(ms / 1000).toFixed(1)}s`; }
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
