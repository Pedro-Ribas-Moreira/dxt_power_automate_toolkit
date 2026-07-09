// ── VIZ — in-page flow visualizer ─────────────────────────────────────────────
(function () {

  // ── State ──────────────────────────────────────────────────────────────────
  var SOL_KEY = '', FLOW_FILE = '', FLOW_NAME = '';
  var DATA = null, PREV_MAP = {}, _uid = 0;
  var _pollInterval = null, _lastDataStr = '';
  var _openSeq = 0;   // bumped on every open()/refresh()/hide() to discard stale async work
  var _insertCtx = null;
  var _pendingOpenEdit = null;
  var _zScale = 1, _zPanX = 0, _zPanY = 0, _zDrag = false, _zSx = 0, _zSy = 0;
  var _viewMode = 'diagram'; // 'diagram' | 'json'
  var _jsonEditMode = false;
  var _undoStack = [], _redoStack = [];   // JSON snapshots of {triggers, actions}
  var UNDO_DEPTH = 20;

  function nextId() { return 'v' + (++_uid); }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function esc(s)   { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escJs(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
  function vsid(n)  { return 'vac_' + n.replace(/[^a-zA-Z0-9]/g,'_'); }
  function fmt(n)   { return n.replace(/_/g,' '); }
  // Normalise @{expr} → @expr when the whole field value IS the expression.
  // Only fires when there are no other @{ inside, so "text @{a} and @{b}" is left untouched.
  function normExpr(v) { if(typeof v==='string'){var m=v.match(/^@\{([^@{]+)\}$/);if(m)return'@'+m[1];}return v; }

  // ── Type metadata ──────────────────────────────────────────────────────────
  var TYPE_META = {
    Request:               { icon:'⚡', cls:'vt-trigger',   label:'Trigger'             },
    ApiConnectionWebhook:  { icon:'⚡', cls:'vt-trigger',   label:'Trigger'             },
    Recurrence:            { icon:'🕐', cls:'vt-trigger',   label:'Scheduled trigger'   },
    Compose:               { icon:'📝', cls:'vt-compose',   label:'Compose'                  },
    Foreach:               { icon:'🔄', cls:'vt-foreach',   label:'Apply to each'            },
    If:                    { icon:'🔀', cls:'vt-condition', label:'Condition'                },
    Scope:                 { icon:'🗂',  cls:'vt-scope',     label:'Scope'                    },
    Until:                 { icon:'🔁', cls:'vt-foreach',   label:'Do until'                 },
    InitializeVariable:    { icon:'📦', cls:'vt-variable',  label:'Initialize variable'      },
    SetVariable:           { icon:'✏️',  cls:'vt-variable',  label:'Set variable'             },
    AppendToStringVariable:{ icon:'➕', cls:'vt-variable',  label:'Append to variable'       },
    IncrementVariable:     { icon:'🔢', cls:'vt-variable',  label:'Increment variable'       },
    ApiConnection:         { icon:'🔌', cls:'vt-api',       label:'Connector action'         },
    OpenApiConnection:     { icon:'🔌', cls:'vt-api',       label:'Connector action'         },
    Http:                  { icon:'🌐', cls:'vt-http',      label:'HTTP'                     },
    ParseJson:             { icon:'📄', cls:'vt-parsejson', label:'Parse JSON'               },
    Select:                { icon:'📋', cls:'vt-compose',   label:'Select (transform array)' },
    Query:                 { icon:'🔍', cls:'vt-compose',   label:'Filter array'             },
    Response:              { icon:'↩',  cls:'vt-response',  label:'Response'                 },
    Terminate:             { icon:'🛑', cls:'vt-other',     label:'Terminate'                },
    Delay:                 { icon:'⏱',  cls:'vt-other',     label:'Delay'                    },
  };
  function typeInfo(t) { return TYPE_META[t] || { icon:'⚙', cls:'vt-other', label:t }; }

  // Human-readable label for the trigger card, based on type + kind.
  function triggerLabel(type, kind) {
    var t = (type || '').toLowerCase();
    var k = (kind || '').toLowerCase();
    if (t === 'request') {
      if (k === 'button')  return 'Manual / Button';
      if (k === 'skills')  return 'Power Apps / Teams';
      if (k === 'http')    return 'HTTP Request';
      return 'HTTP Request';
    }
    if (t === 'recurrence')             return 'Scheduled';
    if (t === 'apiconnectionwebhook')   return 'Webhook';
    if (t === 'apiconnection')          return 'Connector (poll)';
    if (t === 'eventgridtrigger')       return 'Event Grid';
    if (t === 'cdstrigger')             return 'Dataverse';
    if (t === 'openapiconnectionwebhook') return 'Webhook';
    return type || 'Unknown';
  }

  // Icon for the trigger node based on type + kind.
  function triggerIcon(type, kind) {
    var t = (type || '').toLowerCase();
    var k = (kind || '').toLowerCase();
    if (t === 'request') {
      if (k === 'button')  return '🖱';
      if (k === 'skills')  return '🤖';
      return '⚡';
    }
    if (t === 'recurrence') return '🕐';
    return '⚡';
  }

  var CONN_COLORS = {
    sharepointonline:'#0078D4', sharepointfilesfolder:'#0078D4',
    office365:'#D83B01', office365users:'#D83B01', office365groups:'#D83B01',
    microsoftteams:'#6264A7', teams:'#6264A7',
    commondataservice:'#00B7C3', commondataserviceforapps:'#00B7C3', dataverse:'#00B7C3',
    azureblob:'#0089D6', azurequeues:'#0089D6',
    excelonlinebusiness:'#217346', microsoftforms:'#77BC62',
    approvals:'#FFB900', sendgrid:'#009DDC', twilio:'#F22F46',
    sql:'#CC2221', onedriveforbusiness:'#0078D4', planner:'#31752F',
    keyvault:'#ECD53F', flowpush:'#742774',
  };
  var TYPE_COLORS = {
    Request:'#742774', Recurrence:'#742774', ApiConnectionWebhook:'#742774',
    Response:'#107C10', Http:'#085B99', Terminate:'#C0392B', ParseJson:'#00BCD4',
    Compose:'#E06C00', InitializeVariable:'#9B4F96', SetVariable:'#9B4F96',
    IncrementVariable:'#9B4F96', AppendToStringVariable:'#9B4F96',
    Foreach:'#00A4EF', If:'#0078D4', Scope:'#7B5EA7', Delay:'#888',
  };

  function connColor(action) {
    if (!action) return '#888';
    var apiId = action.inputs && action.inputs.host && action.inputs.host.apiId;
    if (apiId) { var k = apiId.split('/').pop().toLowerCase().replace(/[^a-z0-9]/g,''); return CONN_COLORS[k] || '#5B9BD5'; }
    return TYPE_COLORS[action.type] || '#888';
  }
  function connName(action) {
    if (!action) return '';
    var apiId = action.inputs && action.inputs.host && action.inputs.host.apiId;
    if (!apiId) return '';
    var p = apiId.split('/'); return p[p.length-1];
  }
  function isEditable(t) {
    return ['Compose','InitializeVariable','SetVariable','AppendToStringVariable',
            'IncrementVariable','Foreach','If','Until','Http','Response','Terminate',
            'ParseJson','Select','Query',
            'ApiConnection','OpenApiConnection'].indexOf(t) >= 0;
  }
  function findNested(actions, name) {
    if (!actions) return null;
    if (actions[name]) return actions[name];
    for (var k in actions) {
      var a = actions[k];
      var f = findNested(a.actions, name) || findNested(a.else && a.else.actions, name);
      if (f) return f;
    }
    return null;
  }

  // ── Run-after condition style ──────────────────────────────────────────────
  function runAfterInfo(conditions) {
    if (!conditions || !conditions.length) return null;
    var hasFailed  = conditions.indexOf('Failed')    >= 0;
    var hasTimeout = conditions.indexOf('TimedOut')  >= 0;
    var hasSkipped = conditions.indexOf('Skipped')   >= 0;
    var hasSuccess = conditions.indexOf('Succeeded') >= 0;
    // Pure success = normal flow, no decoration needed
    if (hasSuccess && !hasFailed && !hasTimeout && !hasSkipped) return null;
    var cls = hasFailed ? 'ra-failed' : hasTimeout ? 'ra-timeout' : hasSkipped ? 'ra-skipped' : '';
    var dots = [];
    if (hasSuccess) dots.push({color:'#107C10', label:'Is successful'});
    if (hasTimeout) dots.push({color:'#E06C00', label:'Has timed out'});
    if (hasSkipped) dots.push({color:'#888888', label:'Is skipped'});
    if (hasFailed)  dots.push({color:'#C0392B', label:'Has failed'});
    return { cls:cls, dots:dots };
  }

  // ── Topo sort + prev map ───────────────────────────────────────────────────
  function topoSort(actions) {
    var visited = {}, order = [];
    function visit(n) {
      if (visited[n]) return; visited[n] = true;
      var ra = actions[n] && actions[n].runAfter || {};
      for (var d in ra) { if (actions[d]) visit(d); }
      order.push(n);
    }
    for (var n in actions) visit(n);
    return order;
  }
  function buildPrevMap(actions, prev) {
    if (!prev) prev = [];
    var order = topoSort(actions), result = {};
    for (var i = 0; i < order.length; i++) {
      var name = order[i], a = actions[name];
      var here = prev.concat(order.slice(0,i).map(function(n){return{name:n,type:actions[n].type,inputs:actions[n].inputs};}));
      result[name] = here;
      if (a.actions) { var n1=buildPrevMap(a.actions,here); for(var k in n1)result[k]=n1[k]; }
      if (a.else&&a.else.actions) { var n2=buildPrevMap(a.else.actions,here); for(var k2 in n2)result[k2]=n2[k2]; }
    }
    return result;
  }

  // ── Health check ──────────────────────────────────────────────────────────
  function allActionsFlat(actions, out) {
    if (!out) out = [];
    if (!actions) return out;
    for (var n in actions) { var a=actions[n]; out.push({name:n,action:a}); allActionsFlat(a.actions,out); allActionsFlat(a.else&&a.else.actions,out); }
    return out;
  }
  function analyzeFlow(data) {
    var issues = [], all = allActionsFlat(data.actions||{});
    var tList = Object.values(data.triggers||{});
    // Only flag as HTTP if it's a real HTTP endpoint — not Power Apps/Teams (Skills) or manual buttons
    // Also suppress if the trigger already enforces Azure AD user authentication
    var isHttp = tList.some(function(t) {
      if (t.type !== 'Request') return false;
      var k = (t.kind || '').toLowerCase();
      if (k !== 'http' && k !== '') return false;
      var authType = (t.inputs && t.inputs.triggerAuthenticationType || '').toLowerCase();
      return authType !== 'user' && authType !== 'activedirectorymembership';
    });
    // Suppress APIM alert if any connector action targets a specific literal user email (not an expression)
    var hasSpecificUser = all.some(function(e) {
      var a = e.action;
      if (a.type !== 'ApiConnection' && a.type !== 'OpenApiConnection') return false;
      var params = (a.inputs && a.inputs.parameters) || {};
      return Object.values(params).some(function(v) {
        return typeof v === 'string' && v.indexOf('@') > 0 && v.indexOf('@{') < 0;
      });
    });
    if (isHttp && !hasSpecificUser) {
      issues.push({level:'error',icon:'🔒',title:'Register HTTP endpoint in APIM',detail:'Never expose the trigger URL directly. Register in Azure API Management for rate limiting, auth, and audit trail.'});
      if (!all.some(function(e){return e.action.type==='Response';}))
        issues.push({level:'error',icon:'↩',title:'Missing Response action',detail:'HTTP-triggered flows must return a Response on every code path or callers hang (120s timeout).'});
    }
    var hasErr = all.some(function(e){ var ra=e.action.runAfter||{}; return Object.keys(ra).some(function(p){return(ra[p]||[]).some(function(c){var u=c.toUpperCase();return u==='FAILED'||u==='TIMEDOUT'||u==='SKIPPED';});}); });
    if (!hasErr) issues.push({level:'error',icon:'🛡',title:'No error handling (Try/Catch)',detail:'Wrap main logic in a Scope ("Try"), add a Scope on Failed/TimedOut ("Catch"). Send a Teams or email alert inside Catch.'});
    var notif = ['mail','outlook','teams','notification','slack','sms','sendgrid','logfail','logerror','faillog','errortrack','logissue'];
    if (!all.some(function(e){ var a=e.action; if(a.type!=='ApiConnection'&&a.type!=='OpenApiConnection')return false; var h=a.inputs&&a.inputs.host||{}; var t=((h.apiId)||'')+' '+((h.operationId)||'')+' '+((h.connectionName)||''); return notif.some(function(kw){return t.toLowerCase().indexOf(kw)>=0;}); }))
      issues.push({level:'warn',icon:'🔔',title:'No failure notification detected',detail:'No Teams, email, or SMS action found. Add a notification inside your Catch scope.'});
    all.forEach(function(e) {
      if (e.action.type!=='If') return;
      var yE=!e.action.actions||!Object.keys(e.action.actions).length, nE=!e.action.else||!e.action.else.actions||!Object.keys(e.action.else.actions).length;
      if (yE||nE) issues.push({level:'warn',icon:'🔀',title:'Empty branch in: '+e.name.replace(/_/g,' '),detail:(yE&&nE?'Both branches empty.':yE?'Yes branch empty.':'No branch empty.')+' Add a Compose or Terminate to make intent explicit.'});
    });
    all.forEach(function(e) {
      if (e.action.type!=='Http') return;
      var inp=e.action.inputs||{}, hs=inp.headers?JSON.stringify(inp.headers).toLowerCase():'';
      if (!inp.authentication&&hs.indexOf('authorization')<0&&hs.indexOf('api-key')<0&&hs.indexOf('ocp-apim')<0)
        issues.push({level:'warn',icon:'🌐',title:'Unauthenticated HTTP: '+e.name.replace(/_/g,' '),detail:'No auth configured. Add Authorization header or use the Authentication field.'});
    });
    all.forEach(function(e) {
      if (e.action.type!=='Foreach') return;
      if (!e.action.runtimeConfiguration||!e.action.runtimeConfiguration.concurrency)
        issues.push({level:'info',icon:'⚡',title:'Foreach without concurrency limit: '+e.name.replace(/_/g,' '),detail:'Default is up to 50 concurrent iterations — can hit throttle limits. Enable Concurrency Control.'});
    });
    return issues;
  }
  function renderHealth(issues) {
    if (!issues.length) return '<div class="viz-health viz-health-ok"><div class="viz-health-header">✅ <span class="viz-health-summary">Flow looks healthy — no issues found</span></div></div>';
    var errs=issues.filter(function(i){return i.level==='error';}).length, warns=issues.filter(function(i){return i.level==='warn';}).length, infos=issues.filter(function(i){return i.level==='info';}).length;
    var parts=[]; if(errs)parts.push(errs+' error'+(errs>1?'s':'')); if(warns)parts.push(warns+' warning'+(warns>1?'s':'')); if(infos)parts.push(infos+' tip'+(infos>1?'s':''));
    var lvl=errs?'error':warns?'warn':'info', icon=errs?'🔴':warns?'🟡':'🔵';
    var html='<div class="viz-health viz-health-'+lvl+'"><div class="viz-health-header" onclick="VIZ._toggleHealth()">'
      +'<span>'+icon+'</span><span class="viz-health-summary">'+esc(parts.join(' · '))+'</span>'
      +'<span class="viz-health-chev open" id="vHealthChev">›</span></div><div class="viz-health-body" id="vHealthBody">';
    issues.forEach(function(i){ html+='<div class="viz-health-item viz-health-item-'+i.level+'"><div class="viz-health-item-title">'+i.icon+'&nbsp;'+esc(i.title)+'</div><div class="viz-health-item-detail">'+esc(i.detail)+'</div></div>'; });
    return html+'</div></div>';
  }

  // ── Static inputs ──────────────────────────────────────────────────────────
  function staticInputs(action) {
    var t=action.type, inp=action.inputs, rows=[];
    if (t==='ApiConnection'||t==='OpenApiConnection') {
      var host=inp&&inp.host, params=inp&&inp.parameters;
      if (host) { if(host.operationId)rows.push({k:'operationId',v:host.operationId}); if(host.apiId){var seg=String(host.apiId).split('/');rows.push({k:'connector',v:seg[seg.length-1]});} if(host.connectionReferenceName)rows.push({k:'connection',v:host.connectionReferenceName}); }
      if (params) { for(var pk in params){var pv=params[pk];rows.push({k:pk,v:typeof pv==='object'?JSON.stringify(pv):String(pv)});} }
    } else if (t==='Compose') { rows.push({k:'inputs',v:typeof inp==='string'?inp:(inp!==undefined?JSON.stringify(inp):'')});
    } else if (t==='InitializeVariable') { var vr=inp&&inp.variables&&inp.variables[0]; if(vr){rows.push({k:'name',v:String(vr.name||'')});rows.push({k:'type',v:String(vr.type||'String')});if(vr.value!==undefined)rows.push({k:'value',v:String(vr.value)});}
    } else if (t==='SetVariable'||t==='AppendToStringVariable') { if(inp){rows.push({k:'name',v:String(inp.name||'')});if(inp.value!==undefined)rows.push({k:'value',v:String(inp.value)});}
    } else if (t==='IncrementVariable') { if(inp){rows.push({k:'name',v:String(inp.name||'')});rows.push({k:'value',v:String(inp.value!==undefined?inp.value:1)});}
    } else if (t==='Http') { if(inp){rows.push({k:'method',v:(inp.method||'GET').toUpperCase()});rows.push({k:'uri',v:String(inp.uri||'')});if(inp.body!==undefined)rows.push({k:'body',v:typeof inp.body==='string'?inp.body:JSON.stringify(inp.body)});if(inp.headers!==undefined)rows.push({k:'headers',v:JSON.stringify(inp.headers)});}
    } else if (t==='Response') { if(inp){rows.push({k:'statusCode',v:String(inp.statusCode||200)});if(inp.body!==undefined)rows.push({k:'body',v:typeof inp.body==='string'?inp.body:JSON.stringify(inp.body)});}
    } else if (t==='Terminate') { if(inp){rows.push({k:'runStatus',v:String(inp.runStatus||'Succeeded')});if(inp.runError&&inp.runError.message)rows.push({k:'errorMessage',v:String(inp.runError.message)});}
    } else if (t==='ParseJson') { if(inp&&inp.content!==undefined)rows.push({k:'content',v:typeof inp.content==='string'?inp.content:JSON.stringify(inp.content)});
    } else if (inp&&typeof inp==='object') { for(var ik in inp){var iv=inp[ik];rows.push({k:ik,v:typeof iv==='object'?JSON.stringify(iv):String(iv)});}
    } else if (inp!==undefined) { rows.push({k:'inputs',v:String(inp)}); }
    if (!rows.length) return '';
    var html='<div class="viz-pa-section-label">INPUTS</div><table class="viz-pa-table">';
    rows.forEach(function(r){var v=String(r.v),d=v.length>120?v.slice(0,120)+'…':v; html+='<tr><td>'+esc(r.k)+'</td><td title="'+esc(v)+'">'+esc(d)+'</td></tr>';});
    return html+'</table>';
  }

  // ── Dynamic content picker ─────────────────────────────────────────────────
  function buildDC(taId, prev) {
    if (!prev||!prev.length) return '';
    var menuId='vdcm_'+taId;
    var items='<div class="viz-dc-group">⚡ Trigger</div>'
      +'<div class="viz-dc-item" data-ta="'+taId+'" data-expr="@{triggerBody()}" onclick="VIZ._insertDC(this,event)">@{triggerBody()}</div>'
      +'<div class="viz-dc-item" data-ta="'+taId+'" data-expr="@{triggerOutputs()}" onclick="VIZ._insertDC(this,event)">@{triggerOutputs()}</div>';
    for (var i=0;i<prev.length;i++) {
      var pa=prev[i];
      items+='<div class="viz-dc-group">'+esc(pa.name.replace(/_/g,' '))+' <span class="viz-dc-type">'+esc(pa.type)+'</span></div>';
      if (['InitializeVariable','SetVariable','AppendToStringVariable','IncrementVariable'].indexOf(pa.type)>=0) {
        var vn=(pa.inputs&&pa.inputs.variables&&pa.inputs.variables[0]&&pa.inputs.variables[0].name)||(pa.inputs&&pa.inputs.name)||pa.name;
        var ve="@{variables('"+vn+"')}";
        items+='<div class="viz-dc-item" data-ta="'+taId+'" data-expr="'+esc(ve)+'" onclick="VIZ._insertDC(this,event)">'+esc(ve)+'</div>';
      } else if (pa.type==='Compose') {
        var c1="@{outputs('"+pa.name+"')}";
        items+='<div class="viz-dc-item" data-ta="'+taId+'" data-expr="'+esc(c1)+'" onclick="VIZ._insertDC(this,event)">'+esc(c1)+'</div>'
              +'<div class="viz-dc-item" data-ta="'+taId+'" data-expr="'+esc("@{outputs('"+pa.name+"')?['body']}")+'" onclick="VIZ._insertDC(this,event)">'+esc("@{outputs('"+pa.name+"')?['body']}")+'</div>';
      } else {
        var a1="@{body('"+pa.name+"')}";
        items+='<div class="viz-dc-item" data-ta="'+taId+'" data-expr="'+esc(a1)+'" onclick="VIZ._insertDC(this,event)">'+esc(a1)+'</div>'
              +'<div class="viz-dc-item" data-ta="'+taId+'" data-expr="'+esc("@{body('"+pa.name+"')?['value']}")+'" onclick="VIZ._insertDC(this,event)">'+esc("@{body('"+pa.name+"')?['value']}")+'</div>';
      }
    }
    return '<div class="viz-dc-picker"><button class="viz-dc-btn" onclick="VIZ._toggleDC(\''+escJs(menuId)+'\',event)">⚡ Dynamic content ▾</button>'
      +'<div class="viz-dc-menu" id="'+menuId+'">'+items+'</div></div>';
  }

  // ── Edit panel ─────────────────────────────────────────────────────────────
  function buildEditPanel(name, action) {
    var s=vsid(name), prev=PREV_MAP[name]||[], f='';
    if (action.type==='Compose') {
      var cv=typeof action.inputs==='string'?action.inputs:(action.inputs!==undefined?JSON.stringify(action.inputs,null,2):''), cId='vef_'+s+'_inputs';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Value / Expression</div><textarea class="viz-edit-expr" id="'+cId+'">'+esc(cv)+'</textarea>'+buildDC(cId,prev)+'</div>';
    } else if (action.type==='InitializeVariable') {
      var iv=(action.inputs&&action.inputs.variables&&action.inputs.variables[0])||{};
      var ivCurType=(iv.type||'string').toLowerCase();
      var ivOpts=['string','integer','float','boolean','array','object'].map(function(t){var d=t.charAt(0).toUpperCase()+t.slice(1);return'<option value="'+t+'"'+(ivCurType===t?' selected':'')+'>'+d+'</option>';}).join(''), ivVId='vef_'+s+'_varvalue';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Variable name</div><input class="viz-edit-text" id="vef_'+s+'_varname" value="'+esc(iv.name||'')+'"></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Type</div><select class="viz-edit-select viz-select-auto" id="vef_'+s+'_vartype">'+ivOpts+'</select></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Initial value</div><textarea class="viz-edit-expr" id="'+ivVId+'">'+esc(iv.value!==undefined?String(iv.value):'')+'</textarea>'+buildDC(ivVId,prev)+'</div>';
    } else if (action.type==='SetVariable'||action.type==='AppendToStringVariable') {
      var svVId='vef_'+s+'_varvalue';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Variable name</div><input class="viz-edit-text" id="vef_'+s+'_varname" value="'+esc((action.inputs&&action.inputs.name)||'')+'"></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Value</div><textarea class="viz-edit-expr" id="'+svVId+'">'+esc(action.inputs&&action.inputs.value!==undefined?String(action.inputs.value):'')+'</textarea>'+buildDC(svVId,prev)+'</div>';
    } else if (action.type==='IncrementVariable') {
      f='<div class="viz-edit-field"><div class="viz-edit-label">Variable name</div><input class="viz-edit-text" id="vef_'+s+'_varname" value="'+esc((action.inputs&&action.inputs.name)||'')+'"></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Value</div><input class="viz-edit-text viz-input-sm" id="vef_'+s+'_varvalue" value="'+esc(action.inputs&&action.inputs.value!==undefined?String(action.inputs.value):'1')+'"></div>';
    } else if (action.type==='Foreach') {
      var feId='vef_'+s+'_foreach';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Array to iterate</div><textarea class="viz-edit-expr viz-expr-sm" id="'+feId+'">'+esc(action.foreach||'')+'</textarea>'+buildDC(feId,prev)+'</div>';
    } else if (action.type==='If') {
      var condId='vef_'+s+'_expr';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Condition (JSON)</div><textarea class="viz-edit-expr viz-expr-lg" id="'+condId+'">'+esc(JSON.stringify(action.expression||{},null,2))+'</textarea>'+buildDC(condId,prev)+'</div>';
    } else if (action.type==='Http') {
      var hMOpts=['GET','POST','PUT','PATCH','DELETE'].map(function(m){return'<option'+((action.inputs&&action.inputs.method||'GET').toUpperCase()===m?' selected':'')+'>'+m+'</option>';}).join('');
      var hBRaw=action.inputs&&action.inputs.body, hBStr=hBRaw?(typeof hBRaw==='string'?hBRaw:JSON.stringify(hBRaw,null,2)):'', hUId='vef_'+s+'_uri';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Method</div><select class="viz-edit-select viz-select-auto" id="vef_'+s+'_method">'+hMOpts+'</select></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">URI</div><textarea class="viz-edit-expr viz-expr-sm" id="'+hUId+'">'+esc((action.inputs&&action.inputs.uri)||'')+'</textarea>'+buildDC(hUId,prev)+'</div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Body (optional JSON)</div><textarea class="viz-edit-expr" id="vef_'+s+'_body">'+esc(hBStr)+'</textarea></div>';
    } else if (action.type==='Response') {
      var rBRaw=action.inputs&&action.inputs.body, rBStr=rBRaw?(typeof rBRaw==='string'?rBRaw:JSON.stringify(rBRaw,null,2)):'', rBId='vef_'+s+'_body';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Status code</div><input class="viz-edit-text viz-input-xs" id="vef_'+s+'_status" value="'+esc(String((action.inputs&&action.inputs.statusCode)||200))+'"></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Body</div><textarea class="viz-edit-expr" id="'+rBId+'">'+esc(rBStr)+'</textarea>'+buildDC(rBId,prev)+'</div>';
    } else if (action.type==='Terminate') {
      var tCur=(action.inputs&&action.inputs.runStatus)||'Succeeded';
      var tOpts=['Succeeded','Failed','Cancelled'].map(function(st){return'<option'+(tCur===st?' selected':'')+'>'+st+'</option>';}).join('');
      f='<div class="viz-edit-field"><div class="viz-edit-label">Run status</div><select class="viz-edit-select viz-select-auto" id="vef_'+s+'_runstatus">'+tOpts+'</select></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Error message (optional)</div><textarea class="viz-edit-expr viz-expr-sm" id="vef_'+s+'_errmsg">'+esc((action.inputs&&action.inputs.runError&&action.inputs.runError.message)||'')+'</textarea></div>';
    } else if (action.type==='ParseJson') {
      var pjCId='vef_'+s+'_content', pjSId='vef_'+s+'_schema';
      var pjSRaw=action.inputs&&action.inputs.schema, pjSStr=pjSRaw?JSON.stringify(pjSRaw,null,2):'';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Content</div><textarea class="viz-edit-expr viz-expr-sm" id="'+pjCId+'">'+esc(action.inputs&&action.inputs.content!==undefined?String(action.inputs.content):'')+'</textarea>'+buildDC(pjCId,prev)+'</div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Schema (JSON)</div><textarea class="viz-edit-expr viz-expr-xl" id="'+pjSId+'">'+esc(pjSStr)+'</textarea></div>';
    } else if (action.type==='Select') {
      var selFId='vef_'+s+'_from', selMId='vef_'+s+'_map';
      var selMRaw=action.inputs&&action.inputs.select;
      var selMStr=selMRaw?(typeof selMRaw==='object'?JSON.stringify(selMRaw,null,2):String(selMRaw)):'{}';
      f='<div class="viz-edit-field"><div class="viz-edit-label">From (array)</div><textarea class="viz-edit-expr viz-expr-sm" id="'+selFId+'">'+esc((action.inputs&&action.inputs.from)||'')+'</textarea>'+buildDC(selFId,prev)+'</div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Map (JSON)</div><textarea class="viz-edit-expr viz-expr-md" id="'+selMId+'">'+esc(selMStr)+'</textarea></div>';
    } else if (action.type==='Query') {
      var qFId='vef_'+s+'_from', qWId='vef_'+s+'_where';
      f='<div class="viz-edit-field"><div class="viz-edit-label">From (array)</div><textarea class="viz-edit-expr viz-expr-sm" id="'+qFId+'">'+esc((action.inputs&&action.inputs.from)||'')+'</textarea>'+buildDC(qFId,prev)+'</div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Filter expression</div><textarea class="viz-edit-expr viz-expr-sm" id="'+qWId+'">'+esc(action.inputs&&action.inputs.where!==undefined?String(action.inputs.where):'')+'</textarea>'+buildDC(qWId,prev)+'</div>';
    } else if (action.type==='Until') {
      var utEId='vef_'+s+'_expr', utCount=(action.limit&&action.limit.count!==undefined)?String(action.limit.count):'60', utTimeout=(action.limit&&action.limit.timeout)||'PT1H';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Exit condition</div><textarea class="viz-edit-expr viz-expr-sm" id="'+utEId+'">'+esc(action.expression||'')+'</textarea>'+buildDC(utEId,prev)+'</div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Max iterations</div><input class="viz-edit-text viz-input-xs" id="vef_'+s+'_count" value="'+esc(utCount)+'"></div>'
        +'<div class="viz-edit-field"><div class="viz-edit-label">Timeout (ISO 8601, e.g. PT1H)</div><input class="viz-edit-text viz-input-md" id="vef_'+s+'_timeout" value="'+esc(utTimeout)+'"></div>';
    } else if (action.type==='ApiConnection'||action.type==='OpenApiConnection') {
      var apiId=(action.inputs&&action.inputs.host&&action.inputs.host.apiId)||'';
      var opId=(action.inputs&&action.inputs.host&&action.inputs.host.operationId)||'';
      var params=(action.inputs&&action.inputs.parameters)||{};
      var pKeys=Object.keys(params), paramRows='';
      for (var pi=0;pi<pKeys.length;pi++) {
        var pk=pKeys[pi], pv=params[pk];
        var pvStr=typeof pv==='object'?JSON.stringify(pv,null,2):String(pv!==undefined?pv:'');
        var pvId='vef_'+s+'_p_'+pk.replace(/[^a-zA-Z0-9]/g,'_');
        paramRows+='<div class="viz-edit-field"><div class="viz-edit-label">'+esc(pk)+'</div>'
          +'<textarea class="viz-edit-expr viz-expr-sm" id="'+pvId+'" data-param="'+esc(pk)+'">'+esc(pvStr)+'</textarea>'
          +buildDC(pvId,prev)+'</div>';
      }
      f='<div class="viz-api-meta">'+esc(apiId.split('/').pop())+' → '+esc(opId)+'</div>'
        +(paramRows||'<div class="viz-no-params">No parameters</div>');
    } else {
      var gId='vef_'+s+'_inputs_json';
      f='<div class="viz-edit-field"><div class="viz-edit-label">Inputs (JSON)</div><textarea class="viz-edit-expr viz-expr-xl" id="'+gId+'">'+esc(JSON.stringify(action.inputs||{},null,2))+'</textarea>'+buildDC(gId,prev)+'</div>';
    }
    return f+'<div class="viz-edit-actions">'
      +'<button class="viz-save-btn" id="vesave_'+s+'" data-name="'+esc(name)+'" onclick="VIZ._save(this.dataset.name)">Save</button>'
      +'<button class="viz-cancel-btn" data-name="'+esc(name)+'" onclick="VIZ._cancelEdit(this.dataset.name)">Cancel</button>'
      +'</div>';
  }

  // ── Card / loop / condition / scope renderers ──────────────────────────────
  function card(name, action) {
    var info=typeInfo(action.type), s=vsid(name), editable=isEditable(action.type);
    var body=staticInputs(action), color=connColor(action), cn=connName(action);
    return '<div class="viz-card" data-action="'+esc(name)+'">'
      +'<div class="viz-card-head '+info.cls+'" onclick="VIZ._toggleCard(\''+escJs(s)+'\')" style="border-left:4px solid '+color+'">'
      +'<span class="viz-card-icon">'+info.icon+'</span>'
      +'<span class="viz-card-name">'+fmt(name)+'</span>'
      +(cn?'<span class="viz-conn-badge" style="background:'+color+'20;color:'+color+';border-color:'+color+'55">'+cn+'</span>'
          :'<span class="viz-card-type">'+info.label+'</span>')
      +(body?'<span class="viz-card-chevron" id="vchev_'+s+'">›</span>':'')
      +(editable?'<button class="viz-edit-btn" data-name="'+esc(name)+'" onclick="VIZ._openEdit(this.dataset.name,event)" title="Edit" aria-label="Edit action">'+icon('pencil')+'</button>':'')
      +'<button class="viz-copy-btn" data-name="'+esc(name)+'" onclick="VIZ._copy(this.dataset.name,event)" title="Copy action" aria-label="Copy action">'+icon('copy')+'</button>'
      +'<button class="viz-del-btn" data-name="'+esc(name)+'" onclick="VIZ._delete(this.dataset.name,event)" title="Delete" aria-label="Delete action">'+icon('trash')+'</button>'
      +'</div>'
      +'<div class="viz-card-body" id="vcb_'+s+'" style="display:none">'+body+'</div>'
      +(editable?'<div class="viz-edit-panel" id="vep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name,action)+'</div>':'')
      +'</div>';
  }
  function foreachCard(name, action) {
    var fe=action.foreach||'', iId=nextId(), cId=nextId(), s=vsid(name);
    var inner=renderActions(action.actions||{});
    return '<div class="viz-loop-box" data-action="'+esc(name)+'">'
      +'<div class="viz-loop-header" onclick="VIZ._toggleLoop(\''+iId+'\',\''+cId+'\')">'
      +'<span class="viz-card-icon">🔄</span><span class="viz-card-name">'+fmt(name)+'</span>'
      +'<span class="viz-loop-badge" title="'+esc(fe)+'">'+esc(fe)+'</span>'
      +'<span class="viz-card-chevron open" id="'+cId+'">›</span>'
      +'<button class="viz-edit-btn" data-name="'+esc(name)+'" onclick="VIZ._openEdit(this.dataset.name,event)" title="Edit" aria-label="Edit action">'+icon('pencil')+'</button>'
      +'<button class="viz-copy-btn" data-name="'+esc(name)+'" onclick="VIZ._copy(this.dataset.name,event)" title="Copy action" aria-label="Copy action">'+icon('copy')+'</button>'
      +'<button class="viz-del-btn" data-name="'+esc(name)+'" onclick="VIZ._delete(this.dataset.name,event)" title="Delete" aria-label="Delete action">'+icon('trash')+'</button>'
      +'</div>'
      +'<div class="viz-edit-panel" id="vep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name,action)+'</div>'
      +'<div class="viz-loop-inner" id="'+iId+'">'+(inner||emptyBtn(name,'foreach'))+'</div>'
      +'</div>';
  }
  function scopeCard(name, action) {
    var iId=nextId(), cId=nextId(), inner=renderActions(action.actions||{});
    return '<div class="viz-scope-box" data-action="'+esc(name)+'">'
      +'<div class="viz-scope-header" onclick="VIZ._toggleLoop(\''+iId+'\',\''+cId+'\')">'
      +'<span class="viz-card-icon">🗂</span><span class="viz-card-name">'+fmt(name)+'</span>'
      +'<span class="viz-card-type">Scope</span>'
      +'<span class="viz-card-chevron open" id="'+cId+'">›</span>'
      +'<button class="viz-copy-btn" data-name="'+esc(name)+'" onclick="VIZ._copy(this.dataset.name,event)" title="Copy action" aria-label="Copy action">'+icon('copy')+'</button>'
      +'<button class="viz-del-btn" data-name="'+esc(name)+'" onclick="VIZ._delete(this.dataset.name,event)" title="Delete" aria-label="Delete action">'+icon('trash')+'</button>'
      +'</div>'
      +'<div class="viz-scope-inner" id="'+iId+'">'+(inner||emptyBtn(name,'scope'))+'</div>'
      +'</div>';
  }
  function untilCard(name, action) {
    var s=vsid(name), iId=nextId(), cId=nextId();
    var inner=renderActions(action.actions||{});
    var exprShort=action.expression?String(action.expression).slice(0,50):'';
    return '<div class="viz-scope-box" data-action="'+esc(name)+'">'
      +'<div class="viz-scope-header" onclick="VIZ._toggleLoop(\''+iId+'\',\''+cId+'\')">'
      +'<span class="viz-card-icon">🔁</span><span class="viz-card-name">'+fmt(name)+'</span>'
      +'<span class="viz-card-type">Until</span>'
      +(exprShort?'<span class="viz-loop-badge" title="'+esc(action.expression||'')+'">'+esc(exprShort)+'</span>':'')
      +'<span class="viz-card-chevron open" id="'+cId+'">›</span>'
      +'<button class="viz-edit-btn" data-name="'+esc(name)+'" onclick="VIZ._openEdit(this.dataset.name,event)" title="Edit" aria-label="Edit action">'+icon('pencil')+'</button>'
      +'<button class="viz-copy-btn" data-name="'+esc(name)+'" onclick="VIZ._copy(this.dataset.name,event)" title="Copy action" aria-label="Copy action">'+icon('copy')+'</button>'
      +'<button class="viz-del-btn" data-name="'+esc(name)+'" onclick="VIZ._delete(this.dataset.name,event)" title="Delete" aria-label="Delete action">'+icon('trash')+'</button>'
      +'</div>'
      +'<div class="viz-edit-panel" id="vep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name,action)+'</div>'
      +'<div class="viz-scope-inner" id="'+iId+'">'+(inner||emptyBtn(name,'scope'))+'</div>'
      +'</div>';
  }
  function condCard(name, action) {
    var tH=renderActions(action.actions||{}), fH=renderActions((action.else&&action.else.actions)||{}), s=vsid(name);
    return '<div class="viz-cond-wrap">'
      +'<div class="viz-card" data-action="'+esc(name)+'">'
      +'<div class="viz-card-head vt-condition">'
      +'<span class="viz-card-icon">🔀</span><span class="viz-card-name">'+fmt(name)+'</span>'
      +'<span class="viz-card-type">Condition</span>'
      +'<button class="viz-edit-btn" data-name="'+esc(name)+'" onclick="VIZ._openEdit(this.dataset.name,event)" title="Edit" aria-label="Edit action">'+icon('pencil')+'</button>'
      +'<button class="viz-copy-btn" data-name="'+esc(name)+'" onclick="VIZ._copy(this.dataset.name,event)" title="Copy action" aria-label="Copy action">'+icon('copy')+'</button>'
      +'<button class="viz-del-btn" data-name="'+esc(name)+'" onclick="VIZ._delete(this.dataset.name,event)" title="Delete" aria-label="Delete action">'+icon('trash')+'</button>'
      +'</div>'
      +'<div class="viz-edit-panel" id="vep_'+s+'" onclick="event.stopPropagation()">'+buildEditPanel(name,action)+'</div>'
      +'</div>'
      +'<div class="viz-cond-branches">'
      +'<div class="viz-branch viz-branch-yes"><div class="viz-branch-label">✓ Yes</div><div class="viz-branch-inner">'+(tH||emptyBtn(name,'yes'))+'</div></div>'
      +'<div class="viz-branch viz-branch-no"><div class="viz-branch-label">✗ No</div><div class="viz-branch-inner">'+(fH||emptyBtn(name,'no'))+'</div></div>'
      +'</div></div>';
  }
  function insertArrow(pred, succ, raConditions) {
    var info = runAfterInfo(raConditions);
    var arrowCls = info ? ' '+info.cls : '';
    var dotHtml = info && info.dots.length
      ? '<div class="viz-ra-dots">'
        +info.dots.map(function(d){return '<span class="viz-ra-dot" style="background:'+d.color+'" title="'+esc(d.label)+'"></span>';}).join('')
        +'</div>'
      : '';
    return '<div class="viz-insert-row"'+(pred?' data-pred="'+esc(pred)+'"':'')+(succ?' data-succ="'+esc(succ)+'"':'')+'>'
      +'<div class="viz-arrow'+arrowCls+'"></div>'
      +'<button class="viz-insert-btn" onclick="VIZ._requestInsert(this,event)" title="Add action here">+</button>'
      +'<div class="viz-arrow viz-arrow-bottom'+arrowCls+'"></div>'
      +dotHtml
      +'</div>';
  }
  function emptyBtn(parent, branch) {
    return '<div class="viz-empty-branch-btn" data-parent="'+esc(parent)+'" data-branch="'+esc(branch)+'" onclick="VIZ._requestInsertBranch(this,event)">+ Add action</div>';
  }
  function renderActions(actions) {
    if (!actions||!Object.keys(actions).length) return '';
    var order=topoSort(actions), parts=[];
    for (var i=0;i<order.length;i++) {
      var n=order[i], a=actions[n], prev=i>0?order[i-1]:null;
      var raConditions = prev && a.runAfter && a.runAfter[prev] ? a.runAfter[prev] : null;
      parts.push(insertArrow(prev,n,raConditions));
      if (a.type==='Foreach') parts.push(foreachCard(n,a));
      else if (a.type==='If') parts.push(condCard(n,a));
      else if (a.type==='Scope') parts.push(scopeCard(n,a));
      else if (a.type==='Until') parts.push(untilCard(n,a));
      else parts.push(card(n,a));
    }
    if (order.length) parts.push(insertArrow(order[order.length-1],null,null));
    return parts.join('');
  }

  // ── JSON view helpers ─────────────────────────────────────────────────────
  function colorizeJson(json) {
    return esc(json).replace(
      /(&quot;(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^&\\"])*&quot;(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      function(m) {
        if (/&quot;.*&quot;\s*:$/.test(m) || /&quot;.*&quot;:$/.test(m)) return '<span class="vjk">'+m+'</span>';
        if (/^&quot;/.test(m)) return '<span class="vjs">'+m+'</span>';
        if (/true|false/.test(m)) return '<span class="vjb">'+m+'</span>';
        if (/null/.test(m)) return '<span class="vjnu">'+m+'</span>';
        return '<span class="vjn">'+m+'</span>';
      }
    );
  }

  function _buildJsonView(panel) {
    var existing = document.getElementById('viz-json-view');
    if (existing) existing.remove();
    var wrap = document.createElement('div');
    wrap.id = 'viz-json-view';
    wrap.className = 'viz-json-view';
    var json = JSON.stringify(DATA, null, 2);
    if (_jsonEditMode) {
      wrap.innerHTML =
        '<div class="viz-json-toolbar">'
        + '<span class="viz-json-label">Editing JSON</span>'
        + '<div class="viz-json-actions">'
        + '<button class="viz-json-action-btn viz-json-cancel-btn" onclick="VIZ._cancelJsonEdit()">Cancel</button>'
        + '<button class="viz-json-action-btn viz-json-save-btn" onclick="VIZ._saveJson(false)">Save locally</button>'
        + '<button class="viz-json-action-btn viz-json-upload-btn" onclick="VIZ._saveJson(true)">Save &amp; Upload</button>'
        + '</div>'
        + '</div>'
        + '<div class="viz-json-err" id="viz-json-err" style="display:none"></div>'
        + '<textarea class="viz-json-editor" id="viz-json-editor" spellcheck="false">' + esc(json) + '</textarea>';
    } else {
      wrap.innerHTML =
        '<div class="viz-json-toolbar">'
        + '<span class="viz-json-label">Raw JSON</span>'
        + '<div class="viz-json-actions">'
        + '<button class="viz-json-action-btn viz-json-copy-btn" onclick="VIZ._copyJson()">Copy</button>'
        + '<button class="viz-json-action-btn viz-json-edit-btn" onclick="VIZ._editJson()">Edit</button>'
        + '</div>'
        + '</div>'
        + '<pre class="viz-json-pre">' + colorizeJson(json) + '</pre>';
    }
    (panel || document.getElementById('viz-panel')).appendChild(wrap);
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render(data) {
    console.log('[viz] render —', Object.keys(data.triggers||{}).length, 'trigger(s),', Object.keys(data.actions||{}).length, 'action(s)');
    _uid = 0;
    var triggers=data.triggers||{}, actions=data.actions||{};
    try {
    PREV_MAP = buildPrevMap(actions);
    var count=Object.keys(actions).length;
    var tEntry=Object.entries(triggers)[0]||['manual',{type:'Request',kind:'Button'}];
    var tDef=tEntry[1], tInfo=typeInfo(tDef.type);
    var color=TYPE_COLORS[tDef.type]||'#742774';
    var tLabel=triggerLabel(tDef.type, tDef.kind);
    var tIcon=triggerIcon(tDef.type, tDef.kind);

    var trigCard='<div class="viz-card"><div class="viz-card-head '+tInfo.cls+'" style="border-left:4px solid '+color+'">'
      +'<span class="viz-card-icon">'+tIcon+'</span>'
      +'<span class="viz-card-name">'+fmt(tEntry[0])+'</span>'
      +'<span class="viz-card-type">'+esc(tLabel)+'</span>'
      +'</div></div>';

    var panel = document.getElementById('viz-panel');
    if (!panel) { console.warn('[viz] render aborted — #viz-panel not in DOM'); return; }
    var isDiagram = _viewMode === 'diagram';
    panel.innerHTML =
      '<div class="viz-banner" id="viz-banner">✓ Flow updated</div>'
      +'<div class="viz-toolbar">'
      +'<input class="viz-search" type="text" placeholder="Search actions…" aria-label="Search actions" oninput="VIZ._filter(this.value)">'
      +'<div class="viz-view-toggle">'
      +'<button class="viz-view-btn'+(isDiagram?' active':'')+'" data-view="diagram" onclick="VIZ._toggleView(\'diagram\')" title="Diagram view">'+icon('zap')+'Diagram</button>'
      +'<button class="viz-view-btn'+(!isDiagram?' active':'')+'" data-view="json" onclick="VIZ._toggleView(\'json\')" title="Raw JSON">'+icon('code')+'JSON</button>'
      +'</div>'
      +'<button class="viz-refresh-btn icon-only" id="viz-undo-btn" onclick="VIZ.undo()" title="Undo (Ctrl+Z)" aria-label="Undo"'+(_undoStack.length?'':' disabled')+'>'+icon('undo')+'</button>'
      +'<button class="viz-refresh-btn icon-only" id="viz-redo-btn" onclick="VIZ.redo()" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"'+(_redoStack.length?'':' disabled')+'>'+icon('redo')+'</button>'
      +'<button class="viz-refresh-btn icon-only" id="viz-refresh-btn" onclick="VIZ.refresh()" title="Reload this flow from disk" aria-label="Reload flow">'+icon('refresh')+'</button>'
      +'<button class="viz-run-btn" id="viz-run-btn" onclick="VIZ._run()">'+icon('play')+'Run</button>'
      +'</div>'
      +renderHealth(analyzeFlow(data))
      +'<div class="viz-zoom-bar"'+(isDiagram?'':' style="display:none"')+'>'
      +'<button class="viz-zoom-btn icon-only" onclick="VIZ._zoomOut()" title="Zoom out (scroll)" aria-label="Zoom out">'+icon('minus')+'</button>'
      +'<span id="viz-zoom-pct" class="viz-zoom-pct">100%</span>'
      +'<button class="viz-zoom-btn icon-only" onclick="VIZ._zoomIn()" title="Zoom in" aria-label="Zoom in">'+icon('plus')+'</button>'
      +'<button class="viz-zoom-btn viz-zoom-reset" onclick="VIZ._zoomReset()">Reset</button>'
      +'</div>'
      +'<div id="viz-vp"'+(isDiagram?'':' style="display:none"')+'><div class="viz-canvas">'
      +trigCard+renderActions(actions)
      +'</div></div>';

    if (!isDiagram) _buildJsonView(panel);

    if (_pendingOpenEdit) {
      var pending = _pendingOpenEdit; _pendingOpenEdit = null;
      setTimeout(function() {
        var s=vsid(pending), ep=document.getElementById('vep_'+s);
        if (!ep) return;
        ep.style.display='block';
        var body=document.getElementById('vcb_'+s), chev=document.getElementById('vchev_'+s);
        if(body) body.style.display='none'; if(chev) chev.style.display='none';
        ep.scrollIntoView({behavior:'smooth',block:'center'});
      }, 80);
    }
    } catch(renderErr) {
      console.error('[viz] render error:', renderErr);
      var panel2 = document.getElementById('viz-panel');
      if (panel2) panel2.innerHTML = '<div class="viz-loading"><span class="u-red">Render error: '+esc(renderErr.message)+'</span></div>';
    }
  }

  // ── Fetch + polling ────────────────────────────────────────────────────────
  async function fetchData() {
    var url = '/pac/flow-json?solution='+encodeURIComponent(SOL_KEY)+'&flow='+encodeURIComponent(FLOW_FILE);
    console.log('[viz] fetch', url);
    const r = await fetch(url);
    if (!r.ok) {
      console.error('[viz] fetch failed:', r.status, r.statusText);
      throw new Error('HTTP '+r.status);
    }
    var data = await r.json();
    console.log('[viz] fetch ok —', Object.keys(data.triggers||{}).length, 'trigger(s),', Object.keys(data.actions||{}).length, 'action(s)');
    return data;
  }
  // Background polling was removed — it tore down the whole diagram every 2s (killing
  // open edit panels / scroll / selection) and ran forever after navigating away,
  // racing with open(). Updates now happen on explicit user action via VIZ.refresh().
  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  }

  // ── Undo / redo (edit mode) ────────────────────────────────────────────────
  // Every mutation (edit save, insert, delete, paste, raw-JSON save) snapshots
  // the pre-mutation flow. Undo/redo writes the snapshot back through the same
  // /pac/save-flow-json endpoint the JSON editor uses, then re-renders.
  function currentSnapshot() {
    return DATA ? JSON.stringify({ triggers: DATA.triggers, actions: DATA.actions }) : null;
  }
  function pushUndo() {
    var snap = currentSnapshot();
    if (!snap) return;
    _undoStack.push(snap);
    if (_undoStack.length > UNDO_DEPTH) _undoStack.shift();
    _redoStack = [];
    updateUndoBtns();
  }
  function updateUndoBtns() {
    var u = document.getElementById('viz-undo-btn'), r = document.getElementById('viz-redo-btn');
    if (u) u.disabled = !_undoStack.length;
    if (r) r.disabled = !_redoStack.length;
  }
  async function applySnapshot(snapStr) {
    var snap = JSON.parse(snapStr);
    var r = await fetch('/pac/save-flow-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solution: SOL_KEY, flowFile: FLOW_FILE, triggers: snap.triggers, actions: snap.actions }),
    });
    var d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Save failed');
  }
  async function timeTravel(fromStack, toStack, label) {
    if (!fromStack.length || !DATA) return;
    var cur = currentSnapshot();
    var snap = fromStack.pop();
    try {
      await applySnapshot(snap);
      toStack.push(cur);
      if (toStack.length > UNDO_DEPTH) toStack.shift();
      log(label + ' applied', 'ok');
      await VIZ.refresh();
    } catch (e) {
      fromStack.push(snap); // put it back — nothing changed on disk
      if (window.toast) toast(label + ' failed: ' + e.message, 'err');
    }
    updateUndoBtns();
  }

  // ── Zoom + pan ─────────────────────────────────────────────────────────────
  function applyZoom() {
    var c=document.querySelector('.viz-canvas');
    if (c) c.style.transform='translate('+_zPanX+'px,'+_zPanY+'px) scale('+_zScale+')';
    var l=document.getElementById('viz-zoom-pct'); if(l) l.textContent=Math.round(_zScale*100)+'%';
  }

  // ── Insert modal ───────────────────────────────────────────────────────────
  var ACTION_TYPES = [
    // Structure
    {icon:'🔀',label:'Condition',          group:'Structure',
     desc:'If/else branch. Fields: expression {and|or:[{equals|greater|less:[left,right]}]}, actions {}, else.actions {}.',
     type:'If'},
    {icon:'🔄',label:'Apply to each',      group:'Structure',
     desc:'Loop over every item in an array. Fields: foreach "@array-expr", actions {}. Current item via @item(), index via @iterationIndexes().',
     type:'Foreach'},
    {icon:'🗂', label:'Scope',             group:'Structure',
     desc:'Group actions into a named block. Use as Try; add a second Scope with runAfter:{Try:["Failed","TimedOut"]} as Catch.',
     type:'Scope'},
    {icon:'🔁',label:'Do until',           group:'Structure',
     desc:"Loop until expression is true. Fields: expression \"@equals(variables('done'),true)\", limit {count:60,timeout:'PT1H'}, actions {}.",
     type:'Until'},
    // Data Operations
    {icon:'📝',label:'Compose',            group:'Data Operations',
     desc:"Build or transform a single value. inputs: any literal, expression, or object. Output via @outputs('Name').",
     type:'Compose'},
    {icon:'📄',label:'Parse JSON',         group:'Data Operations',
     desc:'Parse a JSON string into a typed object. inputs:{content:"@expr",schema:{type:"object",properties:{Field:{type:"string"}}}}. Generate schema from sample in designer.',
     type:'ParseJson'},
    {icon:'📋',label:'Select',             group:'Data Operations',
     desc:"Project each array item into a new shape. inputs:{from:'@array',select:{FieldA:\"@item()?['src']\"}}. Output is the transformed array.",
     type:'Select'},
    {icon:'🔍',label:'Filter array',       group:'Data Operations',
     desc:"Keep only items matching a condition. inputs:{from:'@array',where:\"@greater(item()?['Amount'],0)\"}. PA type is 'Query'. Output via @body('Name').",
     type:'Query'},
    // Variables
    {icon:'📦',label:'Initialize Variable',group:'Variables',
     desc:'Declare a flow-scoped variable. inputs:{variables:[{name:"VarName",type:"String|Integer|Float|Boolean|Array|Object",value:""}]}. Must appear before Set/Append/Increment.',
     type:'InitializeVariable'},
    {icon:'✏️', label:'Set Variable',       group:'Variables',
     desc:'Overwrite a variable. inputs:{name:"VarName",value:"new value or expression"}. Value type must match the initialized type.',
     type:'SetVariable'},
    {icon:'➕',label:'Append to Variable', group:'Variables',
     desc:'Append text to a String variable. inputs:{name:"VarName",value:"text to append"}. Useful for building log strings inside a loop.',
     type:'AppendToStringVariable'},
    {icon:'🔢',label:'Increment Variable', group:'Variables',
     desc:'Add a number to an Integer variable. inputs:{name:"VarName",value:1}. Use a negative value to decrement.',
     type:'IncrementVariable'},
    // Integration
    {icon:'🌐',label:'HTTP',               group:'Integration',
     desc:'Make an HTTP request. inputs:{method:"POST",uri:"https://...",headers:{},body:{},authentication:{type:"ManagedServiceIdentity"}}.',
     type:'Http'},
    {icon:'↩', label:'Response',           group:'Integration',
     desc:'Return an HTTP response to the caller. inputs:{statusCode:200,body:"...",headers:{}}. Required on every path in an HTTP-triggered flow.',
     type:'Response'},
    {icon:'🛑',label:'Terminate',          group:'Integration',
     desc:'Stop the flow immediately. inputs:{runStatus:"Succeeded|Failed|Cancelled",runError:{code:"...",message:"..."}}.',
     type:'Terminate'},
  ];

  function openInsertModal() {
    var overlay = document.getElementById('viz-modal-overlay');
    var list    = document.getElementById('viz-modal-list');
    if (!overlay||!list) return;

    var groups = {}, groupOrder = [];
    ACTION_TYPES.forEach(function(at) {
      if (!groups[at.group]) { groups[at.group] = []; groupOrder.push(at.group); }
      groups[at.group].push(at);
    });

    var pasteHtml = VIZ._clipboard
      ? '<div class="viz-modal-paste-item" onclick="VIZ._doPaste()">📋 Paste: <strong>'+esc(VIZ._clipboard.name.replace(/_/g,' '))+'</strong></div>'
      : '';

    var html = pasteHtml
      +'<div class="viz-modal-search-row">'
      +'<input class="viz-modal-search-input" id="viz-insert-search" type="text" placeholder="Search actions…" autocomplete="off"'
      +' oninput="VIZ._filterInsertModal(this.value)" onkeydown="VIZ._insertModalKey(event)">'
      +'</div>'
      +'<div class="viz-modal-name-row">'
      +'<label class="viz-modal-name-label">Action name <span class="viz-modal-name-hint">(optional — auto-generated if blank)</span></label>'
      +'<input class="viz-modal-name-input" id="viz-insert-name" type="text" placeholder="e.g. Get Customer Record" autocomplete="off">'
      +'</div>';

    groupOrder.forEach(function(g) {
      html += '<div class="viz-modal-group-label" data-group="'+esc(g.toLowerCase())+'">'+esc(g)+'</div>';
      html += groups[g].map(function(at) {
        return '<div class="viz-modal-item" data-type="'+esc(at.type)+'" data-label="'+esc(at.label.toLowerCase())+'" data-group="'+esc(g.toLowerCase())+'" onclick="VIZ._doInsert(this.dataset.type)">'
          +'<span class="viz-modal-item-icon">'+at.icon+'</span>'
          +'<div><div class="viz-modal-item-label">'+esc(at.label)+'</div><div class="viz-modal-item-desc">'+esc(at.desc)+'</div></div>'
          +'</div>';
      }).join('');
    });

    html += '<div id="viz-insert-no-results" class="viz-no-results" style="display:none">No matching action types</div>';

    list.innerHTML = html;
    overlay.classList.add('open');
    setTimeout(function() { var si=document.getElementById('viz-insert-search'); if(si) si.focus(); }, 60);
  }

  // ── Public API (called from HTML onclick attributes) ───────────────────────
  window.VIZ = {

    _clipboard: null,

    open: async function(solKey, flowFile, flowName) {
      console.log('[viz] open() called —', solKey, '/', flowFile);
      var seq = ++_openSeq;   // guard against overlapping/stale opens
      SOL_KEY   = solKey;
      FLOW_FILE = flowFile;
      FLOW_NAME = flowName || flowFile.replace(/\.json$/,'').replace(/-[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/,'').replace(/-/g,' ').trim();
      _zScale=1; _zPanX=0; _zPanY=0; _viewMode='diagram'; _jsonEditMode=false;

      // Enforce mutual exclusivity: hide every other main view, show only the workspace.
      ['empty-state','solution-view','library-view','assistant-view'].forEach(function(id){
        var el=document.getElementById(id); if(el) el.style.display='none';
      });
      document.getElementById('content').style.display = 'none';
      var nsv=document.getElementById('new-sol-view'); if(nsv) nsv.style.display='none';
      document.getElementById('action-bar').style.display = 'none';
      var ws0 = document.getElementById('flow-workspace');
      ws0.style.display = ''; // clear any stale inline display:none — it would override .open
      ws0.classList.add('open');

      // Update topbar breadcrumb
      document.getElementById('main-title').textContent = APP.selected ? APP.selected.key.replace(/_/g,' ') : '';
      document.getElementById('main-ver').textContent   = FLOW_NAME;
      document.getElementById('btn-pa').style.display        = 'none';
      document.getElementById('btn-viz-back').style.display  = 'inline-flex';

      // Show loading
      var panel = document.getElementById('viz-panel');
      panel.innerHTML = '<div class="viz-loading"><div class="viz-spinner"></div><span>Loading flow…</span></div>';

      try {
        var raw = await fetchData();
        if (seq !== _openSeq) { console.log('[viz] open() superseded — discarding stale fetch'); return; }
        _lastDataStr = JSON.stringify(raw);
        _undoStack = []; _redoStack = [];   // fresh flow — history starts here
        DATA = { name:FLOW_NAME, triggers:raw.triggers||{}, actions:raw.actions||{} };
        render(DATA);
        log('Opened flow: '+FLOW_NAME, 'info');
      } catch(e) {
        if (seq !== _openSeq) return;
        console.error('[viz] open error:', e);
        panel.innerHTML = '<div class="viz-loading"><span class="u-red">Failed to load flow: '+escHtml(e.message)+'</span></div>';
        log('Failed to open flow: '+e.message, 'err');
      }
    },

    // Re-fetch and re-render the current flow on demand (replaces background polling).
    refresh: async function() {
      if (!SOL_KEY || !FLOW_FILE) return;
      var seq = ++_openSeq;
      var btn = document.getElementById('viz-refresh-btn');
      if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
      try {
        var raw = await fetchData();
        if (seq !== _openSeq) return;
        _lastDataStr = JSON.stringify(raw);
        DATA = { name:FLOW_NAME, triggers:raw.triggers||{}, actions:raw.actions||{} };
        render(DATA);
        log('Refreshed flow: '+FLOW_NAME, 'info');
      } catch(e) {
        log('Refresh failed: '+e.message, 'err');
      } finally {
        var b=document.getElementById('viz-refresh-btn');
        if (b) { b.disabled = false; b.classList.remove('spinning'); }
      }
    },

    // Idempotent teardown — hides the workspace and stops any polling WITHOUT
    // any navigation side effects. Called by every "show a main view" entry point
    // (switchView / showSolutionPanel / showNewSolutionForm) so the visualizer can
    // never be left visible underneath another view.
    hide: function() {
      _openSeq++;                          // invalidate any in-flight fetch
      stopPolling();
      var ws = document.getElementById('flow-workspace');
      if (ws) { ws.classList.remove('open'); ws.style.display = ''; }
      var back = document.getElementById('btn-viz-back');
      if (back) back.style.display = 'none';
    },

    close: function() {
      this.hide();
      document.getElementById('content').style.display = '';
      if (APP.selected) {
        document.getElementById('action-bar').style.display = 'flex';
        document.getElementById('btn-pa').style.display = 'inline-flex';
        showSolutionPanel(APP.selected);
      } else {
        var es=document.getElementById('empty-state'); if(es) es.style.display='';
      }
    },

    // ── Card interactions ──────────────────────────────────────────────────
    _toggleCard: function(s) {
      var ep=document.getElementById('vep_'+s); if(ep&&ep.style.display!=='none') return;
      var body=document.getElementById('vcb_'+s), chev=document.getElementById('vchev_'+s);
      if(body) body.style.display=body.style.display==='none'?'block':'none';
      if(chev) chev.classList.toggle('open');
    },
    _toggleLoop: function(iId, cId) {
      var el=document.getElementById(iId), ch=document.getElementById(cId);
      if(el) el.classList.toggle('collapsed'); if(ch) ch.classList.toggle('open');
    },
    _openEdit: function(name, event) {
      event.stopPropagation();
      var s=vsid(name);
      var body=document.getElementById('vcb_'+s), ep=document.getElementById('vep_'+s), chev=document.getElementById('vchev_'+s);
      if(body) body.style.display='none'; if(chev) chev.style.display='none'; if(ep) ep.style.display='block';
    },
    _cancelEdit: function(name) {
      var s=vsid(name);
      var ep=document.getElementById('vep_'+s), chev=document.getElementById('vchev_'+s);
      if(ep) ep.style.display='none'; if(chev) chev.style.display='';
    },
    _filter: function(q) {
      q = q.toLowerCase().trim();
      document.querySelectorAll('.viz-card').forEach(function(c) {
        var nm=((c.querySelector('.viz-card-name')||{}).textContent||'');
        c.style.opacity=(!q||nm.toLowerCase().includes(q))?'1':'0.2';
      });
    },

    // ── Dynamic content ────────────────────────────────────────────────────
    _toggleDC: function(menuId, event) {
      event.stopPropagation();
      document.querySelectorAll('.viz-dc-menu').forEach(function(m){if(m.id!==menuId)m.style.display='none';});
      var menu=document.getElementById(menuId); if(!menu) return;
      if(menu.style.display==='block'){menu.style.display='none';return;}
      var btn=event.currentTarget||event.target, rect=btn.getBoundingClientRect();
      menu.style.top=(rect.bottom+4)+'px'; menu.style.left=rect.left+'px'; menu.style.display='block';
      var mr=menu.getBoundingClientRect();
      if(mr.right>window.innerWidth-8) menu.style.left=Math.max(8,window.innerWidth-mr.width-8)+'px';
      if(mr.bottom>window.innerHeight-8) menu.style.top=Math.max(8,rect.top-mr.height-4)+'px';
    },
    _insertDC: function(el, event) {
      event.stopPropagation();
      var ta=document.getElementById(el.dataset.ta);
      if(ta){var s=ta.selectionStart||0,e=ta.selectionEnd||s; ta.value=ta.value.substring(0,s)+el.dataset.expr+ta.value.substring(e); ta.focus(); ta.selectionStart=ta.selectionEnd=s+el.dataset.expr.length;}
      var menu=el.closest('.viz-dc-menu'); if(menu) menu.style.display='none';
    },

    // ── Health toggle ──────────────────────────────────────────────────────
    _toggleHealth: function() {
      var b=document.getElementById('vHealthBody'), c=document.getElementById('vHealthChev');
      if(b) b.classList.toggle('collapsed'); if(c) c.classList.toggle('open');
    },

    // ── Save ───────────────────────────────────────────────────────────────
    _save: async function(name) {
      var s=vsid(name);
      var action=(DATA.actions&&DATA.actions[name])||findNested(DATA.actions,name);
      if(!action) return;
      var el=function(id){return document.getElementById(id)||{};};
      var patch=null;
      if(action.type==='Compose'){var raw=normExpr(el('vef_'+s+'_inputs').value||''),parsed=raw;try{parsed=JSON.parse(raw);}catch(e){}patch={inputs:parsed};}
      else if(action.type==='InitializeVariable'){var vn=el('vef_'+s+'_varname').value||'',vt=el('vef_'+s+'_vartype').value||'string',vv=normExpr(el('vef_'+s+'_varvalue').value||'');if(vt!=='string'){try{vv=JSON.parse(vv);}catch(e){}}patch={inputs:{variables:[{name:vn,type:vt,value:vv}]}};}
      else if(action.type==='SetVariable'||action.type==='AppendToStringVariable'){var svn=el('vef_'+s+'_varname').value||'',svv=normExpr(el('vef_'+s+'_varvalue').value||'');try{svv=JSON.parse(svv);}catch(e){}patch={inputs:{name:svn,value:svv}};}
      else if(action.type==='IncrementVariable'){var ivn=el('vef_'+s+'_varname').value||'',ivv=el('vef_'+s+'_varvalue').value||'1',ivNum=Number(ivv);patch={inputs:{name:ivn,value:isNaN(ivNum)?ivv:ivNum}};}
      else if(action.type==='Foreach'){patch={foreach:normExpr(el('vef_'+s+'_foreach').value||'')};}
      else if(action.type==='If'){var cs=el('vef_'+s+'_expr').value||'{}';try{patch={expression:JSON.parse(cs)};}catch(e){toast('Invalid JSON','err');return;}}
      else if(action.type==='Http'){var hm=el('vef_'+s+'_method').value||'GET',hu=normExpr(el('vef_'+s+'_uri').value||''),hbs=normExpr(el('vef_'+s+'_body').value||''),hbp=hbs;try{hbp=JSON.parse(hbs);}catch(e){}patch={inputs:Object.assign({},action.inputs||{},{method:hm,uri:hu,body:hbp||undefined})};}
      else if(action.type==='Response'){var rs=parseInt(el('vef_'+s+'_status').value||'200',10),rbs=normExpr(el('vef_'+s+'_body').value||''),rbp=rbs;try{rbp=JSON.parse(rbs);}catch(e){}patch={inputs:Object.assign({},action.inputs||{},{statusCode:rs,body:rbp})};}
      else if(action.type==='Terminate'){var tst=el('vef_'+s+'_runstatus').value||'Succeeded',te=el('vef_'+s+'_errmsg').value||'';patch={inputs:Object.assign({},action.inputs||{},{runStatus:tst,runError:te?{message:te}:undefined})};}
      else if(action.type==='ParseJson'){var pjC=normExpr(el('vef_'+s+'_content').value||''),pjSs=el('vef_'+s+'_schema').value||'{}';try{patch={inputs:Object.assign({},action.inputs||{},{content:pjC,schema:JSON.parse(pjSs)})};}catch(e){toast('Invalid JSON in schema','err');return;}}
      else if(action.type==='Select'){var selF=normExpr(el('vef_'+s+'_from').value||''),selMs=el('vef_'+s+'_map').value||'{}';try{patch={inputs:{from:selF,select:JSON.parse(selMs)}};}catch(e){toast('Invalid JSON in map','err');return;}}
      else if(action.type==='Query'){var qF2=normExpr(el('vef_'+s+'_from').value||''),qW2=normExpr(el('vef_'+s+'_where').value||'');patch={inputs:{from:qF2,where:qW2}};}
      else if(action.type==='Until'){var utE2=normExpr(el('vef_'+s+'_expr').value||''),utCn=parseInt(el('vef_'+s+'_count').value||'60',10),utTo2=el('vef_'+s+'_timeout').value||'PT1H';patch={expression:utE2,limit:{count:isNaN(utCn)?60:utCn,timeout:utTo2}};}
      else if(action.type==='ApiConnection'||action.type==='OpenApiConnection'){var ep2=document.getElementById('vep_'+s),pTAs=ep2?[].slice.call(ep2.querySelectorAll('[data-param]')):[],newP={};pTAs.forEach(function(ta){var k=ta.dataset.param,v=normExpr(ta.value||'');try{v=JSON.parse(v);}catch(ex){}newP[k]=v;});patch={inputs:Object.assign({},action.inputs||{},{parameters:newP})};}
      else{var js=el('vef_'+s+'_inputs_json').value||'{}';try{patch={inputs:JSON.parse(js)};}catch(e){toast('Invalid JSON','err');return;}}
      if(!patch) return;
      pushUndo();
      var btn=document.getElementById('vesave_'+s); if(btn){btn.disabled=true;btn.textContent='Saving…';}
      try {
        var r=await fetch('/pac/save-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({solution:SOL_KEY,flowFile:FLOW_FILE,actionName:name,patch:patch})});
        var d=await r.json();
        if(d.ok){VIZ._cancelEdit(name); log('Saved: '+name,'ok'); VIZ.refresh();}
        else{toast('Save failed: '+d.error,'err');if(btn){btn.disabled=false;btn.textContent='Save';}}
      } catch(e){toast('Save error: '+e.message,'err');if(btn){btn.disabled=false;btn.textContent='Save';}}
    },

    // ── Delete ─────────────────────────────────────────────────────────────
    _delete: async function(name, event) {
      event.stopPropagation();
      if(!confirm('Delete "'+name.replace(/_/g,' ')+'\"?\n\nSuccessors will be rewired to its predecessor.')) return;
      pushUndo();
      try {
        var r=await fetch('/pac/delete-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({solution:SOL_KEY,flowFile:FLOW_FILE,actionName:name})});
        var d=await r.json();
        if(!d.ok){ toast('Delete failed: '+d.error,'err'); }
        else { log('Deleted: '+name,'ok'); VIZ.refresh(); }
      } catch(e){toast('Delete error: '+e.message,'err');}
    },

    // ── Copy / Paste ───────────────────────────────────────────────────────
    _copy: function(name, event) {
      event.stopPropagation();
      VIZ._clipboard = { name: name };
      log('Copied "'+name.replace(/_/g,' ')+'" — use an insert point (＋) to paste', 'info');
    },
    _doPaste: async function() {
      document.getElementById('viz-modal-overlay').classList.remove('open');
      if(!_insertCtx||!VIZ._clipboard) return;
      pushUndo();
      try {
        var r=await fetch('/pac/copy-action',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({solution:SOL_KEY,flowFile:FLOW_FILE,sourceName:VIZ._clipboard.name,
            predecessorName:_insertCtx.pred,successorName:_insertCtx.succ,
            parentAction:_insertCtx.parentAction,branch:_insertCtx.branch})});
        var d=await r.json();
        if(!d.ok) toast('Paste failed: '+d.error,'err');
        else { _pendingOpenEdit=d.newName; log('Pasted as "'+d.newName.replace(/_/g,' ')+'"','ok'); VIZ.refresh(); }
      } catch(e){toast('Paste error: '+e.message,'err');}
    },

    // ── Insert ─────────────────────────────────────────────────────────────
    _requestInsert: function(btn, event) {
      event.stopPropagation();
      var row=btn.closest('.viz-insert-row');
      _insertCtx={pred:row&&row.dataset.pred||null,succ:row&&row.dataset.succ||null,parentAction:null,branch:null};
      openInsertModal();
    },
    _requestInsertBranch: function(el, event) {
      event.stopPropagation();
      _insertCtx={pred:null,succ:null,parentAction:el.dataset.parent,branch:el.dataset.branch};
      openInsertModal();
    },
    _doInsert: async function(actionType) {
      var nameEl=document.getElementById('viz-insert-name');
      var customName=nameEl?nameEl.value.trim():'';
      document.getElementById('viz-modal-overlay').classList.remove('open');
      if(!_insertCtx) return;
      pushUndo();
      try {
        var r=await fetch('/pac/insert-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({solution:SOL_KEY,flowFile:FLOW_FILE,actionType:actionType,customName:customName||null,predecessorName:_insertCtx.pred,successorName:_insertCtx.succ,parentAction:_insertCtx.parentAction,branch:_insertCtx.branch})});
        var d=await r.json();
        if(!d.ok) toast('Insert failed: '+d.error,'err');
        else { _pendingOpenEdit=d.newName; log('Inserted "'+d.newName+'"','ok'); VIZ.refresh(); }
      } catch(e){toast('Insert error: '+e.message,'err');}
    },
    _closeModal: function(event) {
      if(event.target===document.getElementById('viz-modal-overlay'))
        document.getElementById('viz-modal-overlay').classList.remove('open');
    },

    _filterInsertModal: function(query) {
      var q=(query||'').toLowerCase().trim();
      var items=[].slice.call(document.querySelectorAll('#viz-modal-list .viz-modal-item'));
      var visible={};
      items.forEach(function(el){
        var match=!q||(el.dataset.label||'').indexOf(q)>=0||(el.dataset.type||'').toLowerCase().indexOf(q)>=0||(el.dataset.group||'').indexOf(q)>=0;
        el.style.display=match?'':'none';
        if(match) visible[el.dataset.group]=true;
      });
      [].slice.call(document.querySelectorAll('#viz-modal-list .viz-modal-group-label')).forEach(function(gl){
        gl.style.display=(!q||visible[gl.dataset.group])?'':'none';
      });
      var nr=document.getElementById('viz-insert-no-results');
      if(nr) nr.style.display=(q&&!Object.keys(visible).length)?'':'none';
    },

    _insertModalKey: function(event) {
      if(event.key!=='Enter') return;
      var visible=[].slice.call(document.querySelectorAll('#viz-modal-list .viz-modal-item')).filter(function(el){return el.style.display!=='none';});
      if(visible.length===1) VIZ._doInsert(visible[0].dataset.type);
    },

    // ── Run ────────────────────────────────────────────────────────────────
    _run: async function() {
      var btn=document.getElementById('viz-run-btn');
      if(btn){btn.disabled=true;btn.innerHTML=icon('play')+'Running…';}
      document.querySelectorAll('.viz-card').forEach(function(c){c.classList.remove('result-pass','result-fail','result-skip');var rb=c.querySelector('.viz-result-badge');if(rb)rb.remove();});
      try {
        var r=await fetch('/pac/run-flow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({solution:SOL_KEY,flowFile:FLOW_FILE})});
        var d=await r.json();
        if(d.ok) VIZ._applyResults(d.results);
        else{if(btn){btn.disabled=false;btn.innerHTML=icon('play')+'Run';} toast('Run failed: '+d.error,'err');}
      } catch(e){if(btn){btn.disabled=false;btn.innerHTML=icon('play')+'Run';} toast('Run error: '+e.message,'err');}
    },
    _applyResults: function(results) {
      var btn=document.getElementById('viz-run-btn'); if(btn){btn.disabled=false;btn.innerHTML=icon('play')+'Run';}
      var sm=results.actions||{};
      document.querySelectorAll('[data-action]').forEach(function(el){
        var name=el.getAttribute('data-action'),r=sm[name]; if(!r) return;
        var isCard=el.classList.contains('viz-card');
        var cls=r.status==='Succeeded'?'result-pass':r.status==='Skipped'?'result-skip':'result-fail';
        if(isCard) el.classList.add(cls);
        var head=el.querySelector('.viz-card-head,.viz-loop-header,.viz-scope-header');
        if(head&&!head.querySelector('.viz-result-badge')){var b=document.createElement('span');b.className='viz-result-badge';b.textContent=r.status==='Succeeded'?'✅':r.status==='Skipped'?'⊘':'❌';head.appendChild(b);}
        if(!isCard) return;
        var body=el.querySelector('.viz-card-body'); if(!body){body=document.createElement('div');body.className='viz-card-body';}
        body.style.display='block';
        var rows=r.output!==null&&r.output!==undefined?flatObj(typeof r.output==='object'?r.output:{value:r.output}):[];
        body.innerHTML='<div class="viz-card-tabs"><div class="viz-tab-bar"><button class="viz-tab-btn active" onclick="switchVizTab(this,\''+nextId()+'\')">Outputs</button></div><div class="viz-tab-pane active">'+paRows(rows)+(r.error?'<div class="viz-pa-count u-red">❌ '+esc(r.error)+'</div>':'')+'</div></div>';
      });
      var canvas=document.querySelector('.viz-canvas');
      if(canvas){var old=document.getElementById('viz-run-summary');if(old)old.remove();var sum=document.createElement('div');sum.id='viz-run-summary';sum.className='viz-run-summary '+(results.failed>0?'fail':'pass');sum.textContent=results.failed>0?'❌ '+results.failed+' failed · '+results.passed+' passed':'✅ All '+results.passed+' actions passed in '+results.duration+'ms';canvas.insertAdjacentElement('beforebegin',sum);}
    },

    // ── Undo / redo ────────────────────────────────────────────────────────
    undo: function() { return timeTravel(_undoStack, _redoStack, 'Undo'); },
    redo: function() { return timeTravel(_redoStack, _undoStack, 'Redo'); },

    // ── Data accessors (used by chat.js) ──────────────────────────────────
    getData:    function() { return DATA; },
    getSolKey:  function() { return SOL_KEY; },
    getFlowFile: function() { return FLOW_FILE; },

    // ── View toggle ────────────────────────────────────────────────────────
    _toggleView: function(mode) {
      if (_viewMode === mode) return;
      _viewMode = mode;
      document.querySelectorAll('.viz-view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === mode);
      });
      var vp = document.getElementById('viz-vp');
      var zb = document.querySelector('.viz-zoom-bar');
      if (mode === 'json') {
        if (vp) vp.style.display = 'none';
        if (zb) zb.style.display = 'none';
        _buildJsonView();
      } else {
        var jv = document.getElementById('viz-json-view');
        if (jv) jv.remove();
        if (vp) vp.style.display = '';
        if (zb) zb.style.display = '';
      }
    },
    _copyJson: function() {
      if (!DATA) return;
      navigator.clipboard.writeText(JSON.stringify(DATA, null, 2)).then(function() {
        var btn = document.querySelector('.viz-json-copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = 'Copy'; }, 1500); }
      });
    },
    _editJson: function() {
      _jsonEditMode = true;
      _buildJsonView();
      var ta = document.getElementById('viz-json-editor');
      if (ta) ta.focus();
    },
    _cancelJsonEdit: function() {
      _jsonEditMode = false;
      _buildJsonView();
    },
    _saveJson: async function(andUpload) {
      var ta = document.getElementById('viz-json-editor');
      if (!ta) return;
      var errEl = document.getElementById('viz-json-err');
      var saveBtn = document.querySelector('.viz-json-save-btn');
      var uploadBtn = document.querySelector('.viz-json-upload-btn');
      // Validate JSON
      var parsed;
      try { parsed = JSON.parse(ta.value); }
      catch (e) {
        if (errEl) { errEl.textContent = 'JSON error: ' + e.message; errEl.style.display = ''; }
        return;
      }
      if (errEl) errEl.style.display = 'none';
      pushUndo();
      // Disable buttons while saving
      if (saveBtn)   { saveBtn.disabled = true;   saveBtn.textContent   = 'Saving…'; }
      if (uploadBtn) { uploadBtn.disabled = true;  uploadBtn.textContent = 'Saving…'; }
      try {
        var r = await fetch('/pac/save-flow-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ solution: SOL_KEY, flowFile: FLOW_FILE, triggers: parsed.triggers, actions: parsed.actions })
        });
        var d = await r.json();
        if (!d.ok) throw new Error(d.error || 'Save failed');
        // Update in-memory DATA so diagram reflects changes
        DATA.triggers = parsed.triggers || DATA.triggers;
        DATA.actions  = parsed.actions  || DATA.actions;
        log('Flow JSON saved locally', 'ok');
        if (andUpload) {
          if (uploadBtn) uploadBtn.textContent = 'Uploading…';
          var r2 = await fetch('/pac/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: SOL_KEY })
          });
          var d2 = await r2.json();
          if (!d2.ok) throw new Error(d2.error || 'Upload failed');
          log('Solution imported to cloud: ' + SOL_KEY, 'ok');
        }
        _jsonEditMode = false;
        render(DATA);   // full rebuild so BOTH the diagram and JSON views reflect the edit
      } catch (e) {
        if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
        if (saveBtn)   { saveBtn.disabled = false;   saveBtn.textContent   = 'Save locally'; }
        if (uploadBtn) { uploadBtn.disabled = false;  uploadBtn.textContent = 'Save & Upload'; }
      }
    },

    // ── Zoom ───────────────────────────────────────────────────────────────
    _zoomIn:    function(){_zScale=Math.min(_zScale*1.15,3);   applyZoom();},
    _zoomOut:   function(){_zScale=Math.max(_zScale*0.87,0.25);applyZoom();},
    _zoomReset: function(){_zScale=1;_zPanX=0;_zPanY=0;       applyZoom();},
    // Only zoom/pan when the visualizer is actually OPEN and the pointer is
    // over the canvas viewport — previously this hijacked wheel/drag for the
    // whole app once a flow had been opened (the panel DOM stays around after
    // close, so the old #viz-vp existence check never went false again).
    _isVizTarget: function(e){
      var ws=document.getElementById('flow-workspace');
      if(!ws||!ws.classList.contains('open'))return false;
      return !!(e.target&&e.target.closest&&e.target.closest('#viz-vp'));
    },
    _wheelHandler: function(e){if(!VIZ._isVizTarget(e))return;e.preventDefault();_zScale=Math.min(Math.max(_zScale*(e.deltaY>0?0.91:1.1),0.25),3);applyZoom();},
    _mousedown: function(e){if(e.button!==0)return;if(!VIZ._isVizTarget(e))return;if(e.target.closest('.viz-card,.viz-scope-box,.viz-loop-box,.viz-cond-wrap,.viz-insert-row,button,input,select,textarea'))return;_zDrag=true;_zSx=e.clientX-_zPanX;_zSy=e.clientY-_zPanY;document.body.style.cursor='grabbing';},
    _mousemove: function(e){if(!_zDrag)return;_zPanX=e.clientX-_zSx;_zPanY=e.clientY-_zSy;applyZoom();},
    _mouseup:   function(){_zDrag=false;document.body.style.cursor='';},
  };

  // ── Helpers (used in results) ──────────────────────────────────────────────
  function flatObj(obj,p,d){if(d===undefined)d=0;if(p===undefined)p='';var r=[];if(obj===null||obj===undefined)return r;if(Array.isArray(obj)){r.push({k:p+'.length',v:obj.length});return r;}if(typeof obj==='object'){for(var k in obj){var fk=p?p+'.'+k:k,v=obj[k];if(k.startsWith('@odata'))continue;if(d<2&&v&&typeof v==='object'&&!Array.isArray(v))flatObj(v,fk,d+1).forEach(function(x){r.push(x);});else r.push({k:fk,v:v});}return r;}r.push({k:p,v:obj});return r;}
  function paRows(rows){if(!rows.length)return'<div class="viz-pa-count">—</div>';var html='<table class="viz-pa-table">';rows.slice(0,20).forEach(function(row){var v=row.v===null?'null':typeof row.v==='object'?JSON.stringify(row.v):String(row.v);html+='<tr><td>'+esc(row.k)+'</td><td>'+esc(v.length>80?v.slice(0,80)+'…':v)+'</td></tr>';});return html+'</table>'+(rows.length>20?'<div class="viz-pa-count">Showing 20 of '+rows.length+'</div>':'');}
  function switchVizTab(btn,paneId){var tabs=btn.closest('.viz-card-tabs');tabs.querySelectorAll('.viz-tab-btn').forEach(function(b){b.classList.remove('active');});tabs.querySelectorAll('.viz-tab-pane').forEach(function(p){p.classList.remove('active');});btn.classList.add('active');var pane=document.getElementById(paneId);if(pane)pane.classList.add('active');event.stopPropagation();}
  window.switchVizTab = switchVizTab;

  // ── Global event listeners ────────────────────────────────────────────────
  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo/redo while the visualizer is open
  document.addEventListener('keydown', function(e){
    if (!(e.ctrlKey || e.metaKey)) return;
    var ws = document.getElementById('flow-workspace');
    if (!ws || !ws.classList.contains('open')) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); VIZ.undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); VIZ.redo(); }
  });
  window.addEventListener('wheel', function(e){VIZ._wheelHandler(e);}, {passive:false});
  window.addEventListener('mousedown', VIZ._mousedown);
  window.addEventListener('mousemove', VIZ._mousemove);
  window.addEventListener('mouseup',   VIZ._mouseup);
  document.addEventListener('click', function(){document.querySelectorAll('.viz-dc-menu').forEach(function(m){m.style.display='none';});});

})();
