import * as fs from 'fs';
import * as path from 'path';
import { getTokenForScopes } from './sharepoint';
import { info } from './log';

const DV_VERSION = 'v9.2';

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function dvFetch<T>(envUrl: string, apiPath: string, opts?: RequestInit): Promise<T> {
  const cleanUrl = envUrl.replace(/\/$/, '');
  const token = await getTokenForScopes([`${cleanUrl}/.default`]);
  const url = `${cleanUrl}/api/data/${DV_VERSION}/${apiPath}`;
  info(`Dataverse: ${opts?.method ?? 'GET'} ${apiPath.split('?')[0]}`);
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...(opts?.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dataverse ${res.status}: ${body.slice(0, 400)}`);
  }
  if (res.status === 204) { return undefined as T; }
  const json: any = await res.json();
  return (json?.value !== undefined ? json.value : json) as T;
}

// ── Connection References ─────────────────────────────────────────────────────

export interface DvConnectionRef {
  connectionreferencelogicalname: string;
  connectionreferencedisplayname: string;
  connectorid: string;
  statecode: number;
}

export async function dvGetConnectionRefs(envUrl: string, solutionUniqueName?: string): Promise<DvConnectionRef[]> {
  const filter = solutionUniqueName
    ? `?$filter=Microsoft.Dynamics.CRM.InSolution(SolutionUniqueName='${solutionUniqueName}')&$select=connectionreferencelogicalname,connectionreferencedisplayname,connectorid,statecode`
    : `?$select=connectionreferencelogicalname,connectionreferencedisplayname,connectorid,statecode`;
  return dvFetch<DvConnectionRef[]>(envUrl, `connectionreferences${filter}`);
}

export async function dvCheckDependencies(
  sourceEnvUrl: string,
  solutionUniqueName: string,
  targetEnvUrl: string
): Promise<{ missing: DvConnectionRef[]; present: DvConnectionRef[] }> {
  info(`Dataverse: checking dependencies for ${solutionUniqueName}`);
  const [required, existing] = await Promise.all([
    dvGetConnectionRefs(sourceEnvUrl, solutionUniqueName),
    dvGetConnectionRefs(targetEnvUrl),
  ]);
  const existingNames = new Set(existing.map(r => r.connectionreferencelogicalname));
  const missing = required.filter(r => !existingNames.has(r.connectionreferencelogicalname));
  const present = required.filter(r => existingNames.has(r.connectionreferencelogicalname));
  info(`Dataverse: ${required.length} required, ${missing.length} missing, ${present.length} present`);
  return { missing, present };
}

// ── Environment Variables ─────────────────────────────────────────────────────

export const DV_ENV_VAR_TYPES: Record<number, string> = {
  100000000: 'String',
  100000001: 'Number',
  100000002: 'Boolean',
  100000003: 'JSON',
  100000004: 'DataSource',
  100000005: 'Secret',
};

export interface DvEnvVar {
  environmentvariabledefinitionid: string;
  schemaname: string;
  displayname: string;
  description: string;
  type: number;
  defaultvalue: string;
  currentValue?: string; // from expanded environmentvariablevalue
}

export async function dvGetEnvVars(envUrl: string, solutionUniqueName?: string): Promise<DvEnvVar[]> {
  const solFilter = solutionUniqueName
    ? `&$filter=Microsoft.Dynamics.CRM.InSolution(SolutionUniqueName='${solutionUniqueName}')`
    : '';
  const raw = await dvFetch<any[]>(envUrl,
    `environmentvariabledefinitions?$select=environmentvariabledefinitionid,schemaname,displayname,description,type,defaultvalue&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)${solFilter}`
  );
  return raw.map(r => ({
    environmentvariabledefinitionid: r.environmentvariabledefinitionid,
    schemaname: r.schemaname ?? '',
    displayname: r.displayname ?? '',
    description: r.description ?? '',
    type: r.type,
    defaultvalue: r.defaultvalue ?? '',
    currentValue: r.environmentvariabledefinition_environmentvariablevalue?.[0]?.value,
  }));
}

export async function dvCreateEnvVar(envUrl: string, def: {
  schemaname: string;
  displayname: string;
  description?: string;
  type: number;
  defaultvalue?: string;
}): Promise<string> {
  const result = await dvFetch<any>(envUrl, `environmentvariabledefinitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaname: def.schemaname,
      displayname: def.displayname,
      description: def.description ?? '',
      type: def.type,
      defaultvalue: def.defaultvalue ?? '',
    }),
  });
  return result?.environmentvariabledefinitionid ?? '';
}

export async function dvSetEnvVarValue(envUrl: string, definitionId: string, value: string): Promise<void> {
  const existing = await dvFetch<{ environmentvariablevalueid: string }[]>(envUrl,
    `environmentvariablevalues?$filter=_environmentvariabledefinitionid_value eq '${definitionId}'&$select=environmentvariablevalueid`
  );
  if (existing.length) {
    await dvFetch<void>(envUrl, `environmentvariablevalues(${existing[0].environmentvariablevalueid})`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  } else {
    await dvFetch<void>(envUrl, `environmentvariablevalues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value,
        'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${definitionId})`,
      }),
    });
  }
}

export async function dvDeleteEnvVar(envUrl: string, definitionId: string): Promise<void> {
  await dvFetch<void>(envUrl, `environmentvariabledefinitions(${definitionId})`, { method: 'DELETE' });
}
