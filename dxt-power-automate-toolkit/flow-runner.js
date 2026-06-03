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
        iterOutputs[innerName] = { ...result.output, __status: result.status };
        context.outputs[innerName] = iterOutputs[innerName];

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

// ─── Expression resolver ──────────────────────────────────────────────────────
// Handles basic Power Automate expressions like @outputs('Compose'), @variables('x')

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
    const val = context.outputs[name];
    if (!prop) return val;
    // Handle nested path like 'body/value'
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
    const val = context.outputs[name];
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

  // concat(a, b, ...)
  const concatMatch = expr.match(/^concat\((.+)\)$/);
  if (concatMatch) {
    const parts = splitArgs(concatMatch[1]);
    return parts.map(p => evalExpr(p.trim(), context) ?? '').join('');
  }

  // length(collection)
  const lengthMatch = expr.match(/^length\((.+)\)$/);
  if (lengthMatch) {
    const val = evalExpr(lengthMatch[1].trim(), context);
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'string') return val.length;
    return 0;
  }

  // string literals
  if ((expr.startsWith("'") && expr.endsWith("'")) ||
      (expr.startsWith('"') && expr.endsWith('"'))) {
    return expr.slice(1, -1);
  }

  // numbers
  if (!isNaN(expr)) return Number(expr);

  // booleans
  if (expr === 'true') return true;
  if (expr === 'false') return false;

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

async function runFlow(flowPath, mockPath) {
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
      skipped++;
      continue;
    }

    // Find handler
    const handler = ACTION_HANDLERS[type] || ACTION_HANDLERS.__connector;
    let result;

    try {
      result = handler(action, context);
    } catch (err) {
      result = { output: null, status: 'Failed', error: err.message };
    }

    // Store output
    context.outputs[name] = { ...result.output, __status: result.status };

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

  if (failed > 0) process.exit(1);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const flowArg = process.argv[2];
const mockArg = process.argv[3];

if (!flowArg) {
  console.error(`\nUsage: node flow-runner.js <flow.json> [mock-data.json]\n`);
  console.error(`Example:`);
  console.error(`  node flow-runner.js ./src/TestSolutionforPipeline1/Workflows/TestFlowwithClaude-93DDD24B-6B5A-F111-BEC6-000D3AD91E0B.json ./mock-data.json\n`);
  process.exit(1);
}

runFlow(
  path.resolve(flowArg),
  mockArg ? path.resolve(mockArg) : null
).catch(err => {
  console.error(`${c.red}Fatal error: ${err.message}${c.reset}`);
  process.exit(1);
});
