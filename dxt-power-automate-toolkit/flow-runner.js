// flow-runner.js — Local Power Automate flow executor
// Usage: node flow-runner.js <path-to-flow.json> [path-to-mock-data.json]

const fs = require('fs');
const path = require('path');

// ─── Colours for terminal output ────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
  bold:   '\x1b[1m',
};

// ─── Action handlers ─────────────────────────────────────────────────────────
// Each handler receives (action, context) and returns { output, status }
// Add new action types here as your flows grow.

const ACTION_HANDLERS = {

  Compose(action, context) {
    const output = resolveExpression(action.inputs, context);
    return { output, status: 'Succeeded' };
  },

  Condition(action, context) {
    const expr = action.inputs?.['@and'] || action.expression;
    const result = evaluateCondition(expr, context);
    const branch = result ? 'true' : 'false';
    const branchActions = result ? action.actions : action.else?.actions;
    return { output: { result, branch }, status: 'Succeeded', branchActions };
  },

  SetVariable(action, context) {
    const name = action.inputs?.name;
    const value = resolveExpression(action.inputs?.value, context);
    context.variables[name] = value;
    return { output: { [name]: value }, status: 'Succeeded' };
  },

  InitializeVariable(action, context) {
    const name = action.inputs?.variables?.[0]?.name;
    const value = resolveExpression(action.inputs?.variables?.[0]?.value, context);
    context.variables[name] = value ?? null;
    return { output: { [name]: value }, status: 'Succeeded' };
  },

  AppendToStringVariable(action, context) {
    const name = action.inputs?.name;
    const value = resolveExpression(action.inputs?.value, context);
    context.variables[name] = (context.variables[name] || '') + value;
    return { output: { [name]: context.variables[name] }, status: 'Succeeded' };
  },

  ParseJson(action, context) {
    const content = resolveExpression(action.inputs?.content, context);
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      return { output: parsed, status: 'Succeeded' };
    } catch {
      return { output: null, status: 'Failed', error: 'Invalid JSON input' };
    }
  },

  Response(action, context) {
    const body = resolveExpression(action.inputs?.body, context);
    const statusCode = action.inputs?.statusCode || 200;
    return { output: { statusCode, body }, status: 'Succeeded' };
  },

  // Generic HTTP mock — returns mock data if defined, otherwise a placeholder
  Http(action, context) {
    const uri = resolveExpression(action.inputs?.uri, context);
    const method = action.inputs?.method || 'GET';
    const mockKey = `HTTP:${method}:${uri}`;
    const mockResponse = context.mocks?.[mockKey] || context.mocks?.['HTTP:*'] || {
      statusCode: 200,
      body: { mocked: true, message: `Mock response for ${method} ${uri}` }
    };
    console.log(`   ${c.grey}↳ Mock HTTP ${method} → ${uri}${c.reset}`);
    return { output: mockResponse.body, status: 'Succeeded' };
  },

  Foreach(action, context) {
    const collection = resolveExpression(action.foreach, context);
    if (!Array.isArray(collection)) {
      return { output: null, status: 'Failed', error: `foreach target is not an array: ${JSON.stringify(collection)}` };
    }
    const loopName = action._name;
    const innerActions = action.actions || {};
    const innerOrder = resolveExecutionOrder(innerActions);
    const iterations = [];

    console.log(`   ${c.grey}↳ Looping over ${collection.length} items${c.reset}`);

    for (let i = 0; i < collection.length; i++) {
      const item = collection[i];
      context.currentItem[loopName] = item;
      const iterOutputs = {};

      for (const innerName of innerOrder) {
        const innerAction = { ...innerActions[innerName], _name: innerName };
        const innerType = innerAction.type;
        const handler = ACTION_HANDLERS[innerType] || ACTION_HANDLERS.__connector;
        let result;
        try {
          result = handler(innerAction, context);
        } catch (err) {
          result = { output: null, status: 'Failed', error: err.message };
        }
        const innerOutputObj = result.output !== null && result.output !== undefined && typeof result.output === 'object'
          ? { ...result.output, __status: result.status }
          : { __value: result.output, __status: result.status };
        iterOutputs[innerName] = innerOutputObj;
        context.outputs[innerName] = innerOutputObj;

        const icon = result.status === 'Succeeded' ? `${c.green}✅ OK${c.reset}` : `${c.red}❌ FAIL${c.reset}`;
        console.log(`\n${icon}      ${c.bold}[${i + 1}/${collection.length}] ${innerName}${c.reset} ${c.grey}[${innerType}]${c.reset}`);
        if (result.output !== null && result.output !== undefined) {
          console.log(`   ${c.grey}Output: ${c.green}"${result.output}"${c.reset}`);
        }
      }
      iterations.push({ item, outputs: iterOutputs });
    }

    delete context.currentItem[loopName];
    return { output: { iterations: iterations.length }, status: 'Succeeded' };
  },

  ApiConnection(action, context) {
    const operationId = action.inputs?.host?.operationId || action._name;
    const mockData = context.mocks?.[action._name];
    if (mockData) {
      console.log(`   ${c.grey}↳ Mock API call: ${operationId} → ${action._name}${c.reset}`);
      return { output: mockData, status: 'Succeeded' };
    }
    console.log(`   ${c.yellow}⚠ No mock defined for "${action._name}" (${operationId}) — add it to mock-data.json${c.reset}`);
    return { output: { body: { value: [] } }, status: 'Succeeded' };
  },

  // Catch-all for unknown connector actions (SharePoint, Dataverse, Teams, etc.)
  __connector(action, context) {
    const mockKey = action.metadata?.operationMetadataId || action.type;
    const mockData = context.mocks?.[action._name] || context.mocks?.[mockKey];
    if (mockData) {
      console.log(`   ${c.grey}↳ Using mock data for "${action._name}"${c.reset}`);
      return { output: mockData, status: 'Succeeded' };
    }
    console.log(`   ${c.yellow}⚠ No mock defined for "${action._name}" (${action.type}) — skipping${c.reset}`);
    return { output: null, status: 'Succeeded' };
  }
};

// ─── PA function implementations ─────────────────────────────────────────────

function formatDT(dateStr, fmt) {
  const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
  if (isNaN(d.getTime())) return '[invalid date: ' + dateStr + ']';
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const h12 = d.getHours() % 12 || 12;
  const tokens = {
    'yyyy': d.getFullYear(), 'yy': pad(d.getFullYear() % 100),
    'MM': pad(d.getMonth() + 1), 'M': d.getMonth() + 1,
    'dd': pad(d.getDate()), 'd': d.getDate(),
    'HH': pad(d.getHours()), 'H': d.getHours(),
    'hh': pad(h12), 'h': h12,
    'mm': pad(d.getMinutes()), 'm': d.getMinutes(),
    'ss': pad(d.getSeconds()), 's': d.getSeconds(),
    'fff': pad(d.getMilliseconds(), 3), 'ff': pad(Math.floor(d.getMilliseconds() / 10)), 'f': Math.floor(d.getMilliseconds() / 100),
    'tt': d.getHours() < 12 ? 'AM' : 'PM', 'K': 'Z',
  };
  let result = fmt;
  for (const t of Object.keys(tokens).sort((a, b) => b.length - a.length)) {
    result = result.split(t).join(tokens[t]);
  }
  return result;
}

const PA_FUNCTIONS = {
  // ── Date / time ──
  utcNow:           (fmt) => fmt ? formatDT(new Date(), fmt) : new Date().toISOString(),
  formatDateTime:   (dt, fmt) => formatDT(dt, fmt || 'yyyy-MM-ddTHH:mm:ssK'),
  parseDateTime:    (s, locale, fmt) => fmt ? formatDT(new Date(s), fmt) : new Date(s).toISOString(),
  addDays:          (dt, n, fmt) => { const d = new Date(dt); d.setDate(d.getDate() + Number(n)); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  addHours:         (dt, n, fmt) => { const d = new Date(dt); d.setHours(d.getHours() + Number(n)); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  addMinutes:       (dt, n, fmt) => { const d = new Date(dt); d.setMinutes(d.getMinutes() + Number(n)); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  addSeconds:       (dt, n, fmt) => { const d = new Date(dt); d.setSeconds(d.getSeconds() + Number(n)); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  addToTime:        (dt, n, unit, fmt) => {
    const d = new Date(dt); const v = Number(n);
    const u = unit.toLowerCase();
    if (u === 'second')      d.setSeconds(d.getSeconds() + v);
    else if (u === 'minute') d.setMinutes(d.getMinutes() + v);
    else if (u === 'hour')   d.setHours(d.getHours() + v);
    else if (u === 'day')    d.setDate(d.getDate() + v);
    else if (u === 'week')   d.setDate(d.getDate() + v * 7);
    else if (u === 'month')  d.setMonth(d.getMonth() + v);
    else if (u === 'year')   d.setFullYear(d.getFullYear() + v);
    return fmt ? formatDT(d, fmt) : d.toISOString();
  },
  subtractFromTime: (dt, n, unit, fmt) => {
    const d = new Date(dt); const v = Number(n);
    const u = unit.toLowerCase();
    if (u === 'second')      d.setSeconds(d.getSeconds() - v);
    else if (u === 'minute') d.setMinutes(d.getMinutes() - v);
    else if (u === 'hour')   d.setHours(d.getHours() - v);
    else if (u === 'day')    d.setDate(d.getDate() - v);
    else if (u === 'week')   d.setDate(d.getDate() - v * 7);
    else if (u === 'month')  d.setMonth(d.getMonth() - v);
    else if (u === 'year')   d.setFullYear(d.getFullYear() - v);
    return fmt ? formatDT(d, fmt) : d.toISOString();
  },
  getFutureTime:    (n, unit, fmt) => {
    const d = new Date(); const v = Number(n); const u = unit.toLowerCase();
    if (u === 'second')      d.setSeconds(d.getSeconds() + v);
    else if (u === 'minute') d.setMinutes(d.getMinutes() + v);
    else if (u === 'hour')   d.setHours(d.getHours() + v);
    else if (u === 'day')    d.setDate(d.getDate() + v);
    else if (u === 'week')   d.setDate(d.getDate() + v * 7);
    else if (u === 'month')  d.setMonth(d.getMonth() + v);
    else if (u === 'year')   d.setFullYear(d.getFullYear() + v);
    return fmt ? formatDT(d, fmt) : d.toISOString();
  },
  getPastTime:      (n, unit, fmt) => {
    const d = new Date(); const v = Number(n); const u = unit.toLowerCase();
    if (u === 'second')      d.setSeconds(d.getSeconds() - v);
    else if (u === 'minute') d.setMinutes(d.getMinutes() - v);
    else if (u === 'hour')   d.setHours(d.getHours() - v);
    else if (u === 'day')    d.setDate(d.getDate() - v);
    else if (u === 'week')   d.setDate(d.getDate() - v * 7);
    else if (u === 'month')  d.setMonth(d.getMonth() - v);
    else if (u === 'year')   d.setFullYear(d.getFullYear() - v);
    return fmt ? formatDT(d, fmt) : d.toISOString();
  },
  startOfDay:       (dt, fmt) => { const d = new Date(dt); d.setHours(0,0,0,0); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  startOfHour:      (dt, fmt) => { const d = new Date(dt); d.setMinutes(0,0,0); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  startOfMonth:     (dt, fmt) => { const d = new Date(dt); d.setDate(1); d.setHours(0,0,0,0); return fmt ? formatDT(d, fmt) : d.toISOString(); },
  convertTimeZone:  (dt, fromTz, toTz, fmt) => {
    try {
      const d = new Date(dt);
      const str = d.toLocaleString('en-US', { timeZone: toTz });
      const converted = new Date(str);
      return fmt ? formatDT(converted, fmt) : converted.toISOString();
    } catch { return String(dt); }
  },
  convertToUtc:     (dt, fromTz, fmt) => {
    try { const d = new Date(new Date(dt).toLocaleString('en-US', { timeZone: fromTz })); return fmt ? formatDT(d, fmt) : d.toISOString(); }
    catch { return String(dt); }
  },
  convertFromUtc:   (dt, toTz, fmt) => {
    try { const d = new Date(new Date(dt).toLocaleString('en-US', { timeZone: toTz })); return fmt ? formatDT(d, fmt) : d.toISOString(); }
    catch { return String(dt); }
  },
  dateDifference:   (dt1, dt2) => { const ms = new Date(dt2) - new Date(dt1); return { days: Math.floor(ms/86400000), hours: Math.floor(ms/3600000), minutes: Math.floor(ms/60000), seconds: Math.floor(ms/1000) }; },
  ticks:            (dt) => (new Date(dt).getTime() * 10000) + 621355968000000000,
  dayOfWeek:        (dt) => new Date(dt).getDay(),
  dayOfMonth:       (dt) => new Date(dt).getDate(),
  dayOfYear:        (dt) => { const d = new Date(dt); return Math.ceil((d - new Date(d.getFullYear(),0,1)) / 86400000) + 1; },
  month:            (dt) => new Date(dt).getMonth() + 1,
  year:             (dt) => new Date(dt).getFullYear(),

  // ── String ──
  concat:           (...args) => args.map(a => a ?? '').join(''),
  length:           (v) => (Array.isArray(v) || typeof v === 'string') ? v.length : 0,
  slice:            (v, start, end) => end !== undefined ? v.slice(start, end) : v.slice(start),
  formatNumber:     (n, fmt) => {
    const num = Number(n); const f = String(fmt);
    if (/^[Nn]\d*$/.test(f)) return num.toLocaleString('en-US', { minimumFractionDigits: parseInt(f.slice(1))||2, maximumFractionDigits: parseInt(f.slice(1))||2 });
    if (/^[Ff]\d*$/.test(f)) return num.toFixed(parseInt(f.slice(1))||2);
    if (/^[Cc]\d*$/.test(f)) return '$' + num.toFixed(parseInt(f.slice(1))||2);
    if (/^[Pp]\d*$/.test(f)) return (num*100).toFixed(parseInt(f.slice(1))||0) + ' %';
    if (/^[Dd]\d*$/.test(f)) return String(Math.round(num)).padStart(parseInt(f.slice(1))||1, '0');
    if (/^[Ee]\d*$/.test(f)) return num.toExponential(parseInt(f.slice(1))||6);
    return String(num);
  },
  string:           (v) => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v),
  trim:             (s) => String(s ?? '').trim(),
  trimStart:        (s) => String(s ?? '').trimStart(),
  trimEnd:          (s) => String(s ?? '').trimEnd(),
  toLower:          (s) => String(s ?? '').toLowerCase(),
  toUpper:          (s) => String(s ?? '').toUpperCase(),
  replace:          (s, old, nw) => String(s ?? '').split(old).join(nw ?? ''),
  substring:        (s, start, len) => len !== undefined ? String(s).substr(start, len) : String(s).substr(start),
  indexOf:          (s, sub) => String(s).indexOf(sub),
  lastIndexOf:      (s, sub) => String(s).lastIndexOf(sub),
  startsWith:       (s, sub) => String(s).startsWith(sub),
  endsWith:         (s, sub) => String(s).endsWith(sub),
  split:            (s, delim) => String(s).split(delim),
  chunk:            (arr, size) => { const r = []; for (let i=0; i<arr.length; i+=size) r.push(arr.slice(i,i+size)); return r; },
  padLeft:          (s, n, ch) => String(s).padStart(n, ch || ' '),
  padRight:         (s, n, ch) => String(s).padEnd(n, ch || ' '),
  nthIndexOf:       (s, sub, n) => { let i = -1; for(let c=0;c<n;c++) { i = String(s).indexOf(sub, i+1); if(i===-1) break; } return i; },

  // ── Type conversion & checking ──
  int:              (v) => parseInt(v, 10),
  float:            (v) => parseFloat(v),
  bool:             (v) => v === 'true' || v === true || v === 1,
  decimal:          (v) => parseFloat(v),
  isFloat:          (v) => typeof v === 'number' ? !Number.isInteger(v) : !isNaN(parseFloat(v)) && String(v).includes('.'),
  isInt:            (v) => typeof v === 'number' ? Number.isInteger(v) : !isNaN(parseInt(v)) && !String(v).includes('.'),
  createArray:      (...args) => args,
  array:            (v) => Array.isArray(v) ? v : [v],
  object:           () => ({}),
  binary:           (v) => Buffer.from(String(v)).toString('binary'),
  dataUri:          (v) => 'data:text/plain;charset=utf-8;base64,' + Buffer.from(String(v)).toString('base64'),
  dataUriToBinary:  (uri) => { const b64 = uri.split(',')[1]; return b64 ? Buffer.from(b64,'base64').toString('binary') : ''; },
  dataUriToString:  (uri) => { const b64 = uri.split(',')[1]; return b64 ? Buffer.from(b64,'base64').toString('utf8') : ''; },
  decodeDataUri:    (uri) => { const b64 = uri.split(',')[1]; return b64 ? Buffer.from(b64,'base64').toString('utf8') : ''; },
  uriComponent:     (s) => encodeURIComponent(s),
  encodeUriComponent: (s) => encodeURIComponent(s),
  decodeUriComponent: (s) => decodeURIComponent(s),
  uriComponentToBinary: (s) => Buffer.from(decodeURIComponent(s)).toString('binary'),
  uriComponentToString: (s) => decodeURIComponent(s),

  // ── Logic ──
  if:               (cond, t, f) => cond ? t : f,
  equals:           (a, b) => a == b,
  not:              (v) => !v,
  and:              (...args) => args.every(Boolean),
  or:               (...args) => args.some(Boolean),
  greater:          (a, b) => a > b,
  greaterOrEquals:  (a, b) => a >= b,
  less:             (a, b) => a < b,
  lessOrEquals:     (a, b) => a <= b,
  empty:            (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0),
  coalesce:         (...args) => args.find(a => a !== null && a !== undefined) ?? null,
  contains:         (col, val) => Array.isArray(col) ? col.includes(val) : typeof col === 'string' ? col.includes(val) : (col && val in col),

  // ── Math ──
  add:              (a, b) => Number(a) + Number(b),
  sub:              (a, b) => Number(a) - Number(b),
  mul:              (a, b) => Number(a) * Number(b),
  div:              (a, b) => Number(a) / Number(b),
  mod:              (a, b) => Number(a) % Number(b),
  min:              (...args) => Math.min(...args.flat().map(Number)),
  max:              (...args) => Math.max(...args.flat().map(Number)),
  abs:              (n) => Math.abs(Number(n)),
  power:            (b, e) => Math.pow(Number(b), Number(e)),
  rand:             (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,

  // ── Array ──
  first:            (arr) => Array.isArray(arr) ? arr[0] : null,
  last:             (arr) => Array.isArray(arr) ? arr[arr.length - 1] : null,
  take:             (arr, n) => Array.isArray(arr) ? arr.slice(0, n) : String(arr).slice(0, n),
  skip:             (arr, n) => Array.isArray(arr) ? arr.slice(n) : String(arr).slice(n),
  reverse:          (arr) => [...arr].reverse(),
  join:             (arr, delim) => arr.join(delim ?? ','),
  union:            (...arrs) => [...new Set(arrs.flat())],
  intersection:     (a, b) => a.filter(x => b.includes(x)),
  except:           (a, b) => a.filter(x => !b.includes(x)),
  range:            (start, count) => Array.from({length: count}, (_, i) => start + i),
  flatten:          (arr) => arr.flat(),
  sort:             (arr) => [...arr].sort(),
  sortBy:           (arr, key) => [...arr].sort((a,b) => a[key] > b[key] ? 1 : -1),
  select:           (arr, fn) => arr,   // simplified — real PA uses lambda

  // ── JSON / encoding ──
  json:             (s) => { try { return JSON.parse(s); } catch { return null; } },
  base64:           (s) => Buffer.from(String(s)).toString('base64'),
  base64ToBinary:   (s) => Buffer.from(s, 'base64').toString('binary'),
  base64ToString:   (s) => Buffer.from(s, 'base64').toString('utf8'),
  decodeBase64:     (s) => Buffer.from(s, 'base64').toString('utf8'),
  encodeBase64:     (s) => Buffer.from(String(s)).toString('base64'),
  encodeURIComponent: (s) => encodeURIComponent(s),
  decodeURIComponent: (s) => decodeURIComponent(s),
  guid:             () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r=Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); }),

  // ── JSON object manipulation ──
  addProperty:      (obj, key, val) => { const r = Object.assign({}, obj); r[key] = val; return r; },
  removeProperty:   (obj, key) => { const r = Object.assign({}, obj); delete r[key]; return r; },
  setProperty:      (obj, key, val) => { const r = Object.assign({}, obj); r[key] = val; return r; },

  // ── URI parsing ──
  uriHost:          (uri) => { try { return new URL(uri).hostname; } catch { return ''; } },
  uriPath:          (uri) => { try { return new URL(uri).pathname; } catch { return ''; } },
  uriPathAndQuery:  (uri) => { try { const u = new URL(uri); return u.pathname + u.search; } catch { return ''; } },
  uriPort:          (uri) => { try { return new URL(uri).port; } catch { return ''; } },
  uriQuery:         (uri) => { try { return new URL(uri).search; } catch { return ''; } },
  uriScheme:        (uri) => { try { return new URL(uri).protocol.replace(':',''); } catch { return ''; } },
};

// ─── Expression resolver ──────────────────────────────────────────────────────
// Handles Power Automate expressions like @outputs('Compose'), @variables('x'), @formatDateTime(...)

function resolveExpression(input, context) {
  if (input === null || input === undefined) return input;
  if (typeof input === 'object') {
    if (Array.isArray(input)) return input.map(i => resolveExpression(i, context));
    const result = {};
    for (const [k, v] of Object.entries(input)) result[k] = resolveExpression(v, context);
    return result;
  }
  if (typeof input !== 'string') return input;

  // Full expression: @{...} or @...
  if (input.startsWith('@{') && input.endsWith('}')) {
    return evalExpr(input.slice(2, -1), context);
  }
  if (input.startsWith('@') && !input.startsWith('@{')) {
    return evalExpr(input.slice(1), context);
  }

  // Inline expressions within a string: "Hello @{triggerBody()?['name']}"
  return input.replace(/@\{([^}]+)\}/g, (_, expr) => {
    const val = evalExpr(expr, context);
    return val !== undefined && val !== null ? String(val) : '';
  });
}

function evalExpr(expr, context) {
  expr = expr.trim();

  // outputs('ActionName')?['body/value'] or outputs('ActionName')?['property']
  const outputsMatch = expr.match(/^outputs\(['"](.+?)['"]\)(\??\[['"](.+?)['"]\])?/);
  if (outputsMatch) {
    const name = outputsMatch[1];
    const prop = outputsMatch[3];
    const stored = context.outputs[name];
    // unwrap primitives stored under __value
    const val = stored?.__value !== undefined ? stored.__value : stored;
    if (!prop) return val;
    if (prop.includes('/')) {
      return prop.split('/').reduce((obj, key) => obj?.[key], val);
    }
    return val?.[prop];
  }

  // body('ActionName')?['property']
  const bodyMatch = expr.match(/^body\(['"](.+?)['"]\)(\??\[['"](.+?)['"]\])?/);
  if (bodyMatch) {
    const name = bodyMatch[1];
    const prop = bodyMatch[3];
    const stored = context.outputs[name];
    const val = stored?.__value !== undefined ? stored.__value : stored;
    return prop ? val?.[prop] : val;
  }

  // variables('name')
  const varMatch = expr.match(/^variables\(['"](.+?)['"]\)/);
  if (varMatch) return context.variables[varMatch[1]];

  // triggerBody()?['property']
  const triggerMatch = expr.match(/^triggerBody\(\)(\??\[['"](.+?)['"]\])?/);
  if (triggerMatch) {
    const prop = triggerMatch[2];
    return prop ? context.triggerBody?.[prop] : context.triggerBody;
  }

  // triggerOutputs()
  if (expr === 'triggerOutputs()') return context.triggerBody;

  // items('LoopName')
  const itemsMatch = expr.match(/^items\(['"](.+?)['"]\)/);
  if (itemsMatch) return context.currentItem[itemsMatch[1]];

  // string literals
  if ((expr.startsWith("'") && expr.endsWith("'")) ||
      (expr.startsWith('"') && expr.endsWith('"'))) {
    return expr.slice(1, -1);
  }

  // numbers
  if (!isNaN(expr) && expr !== '') return Number(expr);

  // booleans / null
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'null') return null;

  // generic function call → PA_FUNCTIONS dispatch
  const fnMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(([\s\S]*)\)$/);
  if (fnMatch) {
    const fnName = fnMatch[1];
    const argsRaw = fnMatch[2].trim();
    const args = argsRaw ? splitArgs(argsRaw).map(a => evalExpr(a.trim(), context)) : [];
    if (PA_FUNCTIONS[fnName]) {
      try { return PA_FUNCTIONS[fnName](...args); }
      catch (e) { return `[fn error: ${fnName}() — ${e.message}]`; }
    }
    return `[unknown fn: ${fnName}]`;
  }

  return `[unresolved: ${expr}]`;
}

function splitArgs(str) {
  const args = [];
  let depth = 0, current = '';
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function evaluateCondition(expr, context) {
  if (!expr) return false;
  if (Array.isArray(expr)) return expr.every(e => evaluateCondition(e, context));
  if (expr.equals) {
    const [a, b] = expr.equals.map(v => resolveExpression(v, context));
    return a == b;
  }
  if (expr.not) return !evaluateCondition(expr.not, context);
  if (expr.greater) {
    const [a, b] = expr.greater.map(v => resolveExpression(v, context));
    return a > b;
  }
  if (expr.less) {
    const [a, b] = expr.less.map(v => resolveExpression(v, context));
    return a < b;
  }
  return false;
}

// ─── Action execution order resolver ─────────────────────────────────────────

function resolveExecutionOrder(actions) {
  const order = [];
  const visited = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const deps = Object.keys(actions[name]?.runAfter || {});
    for (const dep of deps) visit(dep);
    order.push(name);
  }

  for (const name of Object.keys(actions)) visit(name);
  return order;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runFlow(flowPath, mockPath, outputJson = false) {
  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║       Power Automate Local Runner        ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚══════════════════════════════════════════╝${c.reset}\n`);

  // Load flow
  const flowRaw = fs.readFileSync(flowPath, 'utf8');
  const flow = JSON.parse(flowRaw);
  const definition = flow.properties?.definition || flow.definition || flow;
  const actions = definition.actions || {};
  const trigger = Object.entries(definition.triggers || {})[0];

  // Load mocks
  let mocks = {};
  if (mockPath && fs.existsSync(mockPath)) {
    mocks = JSON.parse(fs.readFileSync(mockPath, 'utf8'));
    console.log(`${c.grey}📂 Mock data loaded from ${mockPath}${c.reset}\n`);
  }

  console.log(`${c.grey}📄 Flow: ${path.basename(flowPath)}${c.reset}`);
  console.log(`${c.grey}🔢 Actions found: ${Object.keys(actions).length}${c.reset}\n`);
  console.log(`${'─'.repeat(50)}`);

  // Set up context
  const context = {
    outputs: {},
    variables: {},
    triggerBody: mocks?.triggerBody || {},
    currentItem: {},
    mocks
  };

  // Fire trigger
  const [triggerName, triggerDef] = trigger || ['manual', {}];
  console.log(`\n${c.bold}▶ TRIGGER${c.reset} ${c.cyan}${triggerName}${c.reset} ${c.grey}(${triggerDef.type}/${triggerDef.kind || ''})${c.reset}`);
  console.log(`  ${c.grey}Body: ${JSON.stringify(context.triggerBody)}${c.reset}`);

  // Execute actions in dependency order
  const order = resolveExecutionOrder(actions);
  let passed = 0, failed = 0, skipped = 0;
  const startTime = Date.now();
  const actionResults = {}; // clean results for --output-json (avoids string-spread bug)

  for (const name of order) {
    const action = { ...actions[name], _name: name };
    const type = action.type;

    // Check runAfter conditions
    const deps = action.runAfter || {};
    let canRun = true;
    for (const [dep, statuses] of Object.entries(deps)) {
      const depStatus = context.outputs[dep]?.__status;
      if (!statuses.includes(depStatus)) {
        canRun = false;
        break;
      }
    }

    if (!canRun) {
      console.log(`\n${c.yellow}⊘ SKIP${c.reset}    ${c.bold}${name}${c.reset} ${c.grey}(dependency not met)${c.reset}`);
      actionResults[name] = { status: 'Skipped', output: null };
      skipped++;
      continue;
    }

    // Find handler
    const handler = ACTION_HANDLERS[type] || ACTION_HANDLERS.__connector;
    let result;

    // Resolve inputs before execution so we can show them in the visualizer
    let resolvedInputs = null;
    try {
      const rawInputs = action.inputs ?? action.foreach;
      resolvedInputs = rawInputs !== undefined ? resolveExpression(rawInputs, context) : null;
    } catch {}

    try {
      result = handler(action, context);
    } catch (err) {
      result = { output: null, status: 'Failed', error: err.message };
    }

    // Capture clean result before storing in context (spreading a string gives {"0":"N",...})
    actionResults[name] = { status: result.status, output: result.output, error: result.error, inputs: resolvedInputs };

    // Store output — keep primitive values under __value to avoid spread corruption
    const outputObj = result.output !== null && result.output !== undefined && typeof result.output === 'object'
      ? { ...result.output, __status: result.status }
      : { __value: result.output, __status: result.status };
    context.outputs[name] = outputObj;

    // Print result
    const icon = result.status === 'Succeeded' ? `${c.green}✅ OK${c.reset}` : `${c.red}❌ FAIL${c.reset}`;
    console.log(`\n${icon}      ${c.bold}${name}${c.reset} ${c.grey}[${type}]${c.reset}`);
    if (result.error) console.log(`   ${c.red}Error: ${result.error}${c.reset}`);
    if (result.output !== null && result.output !== undefined) {
      const outputStr = typeof result.output === 'object'
        ? JSON.stringify(result.output, null, 2).split('\n').map(l => `   ${l}`).join('\n')
        : `   ${c.green}"${result.output}"${c.reset}`;
      console.log(`   ${c.grey}Output:${c.reset}`);
      console.log(outputStr);
    }

    result.status === 'Succeeded' ? passed++ : failed++;
  }

  // Summary
  const duration = Date.now() - startTime;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`\n${c.bold}RESULT${c.reset}  ${c.green}${passed} passed${c.reset}  ${failed > 0 ? c.red : c.grey}${failed} failed${c.reset}  ${c.yellow}${skipped} skipped${c.reset}  ${c.grey}(${duration}ms)${c.reset}\n`);

  if (outputJson) {
    process.stdout.write('\n__PA_RESULTS__' + JSON.stringify({ passed, failed, skipped, duration, actions: actionResults }) + '\n');
  }

  if (failed > 0) process.exit(1);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let flowArg = null, mockArg = null, outputJson = false;
for (const arg of argv) {
  if (arg === '--output-json') { outputJson = true; }
  else if (!flowArg) { flowArg = arg; }
  else if (!mockArg) { mockArg = arg; }
}

if (!flowArg) {
  console.error(`\nUsage: node flow-runner.js <flow.json> [mock-data.json] [--output-json]\n`);
  process.exit(1);
}

runFlow(
  path.resolve(flowArg),
  mockArg ? path.resolve(mockArg) : null,
  outputJson
).catch(err => {
  console.error(`${c.red}Fatal error: ${err.message}${c.reset}`);
  process.exit(1);
});
