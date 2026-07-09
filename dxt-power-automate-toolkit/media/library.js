// ── Actions Library browser ─────────────────────────────────────────────────────
(function () {

  var _lib = null;
  var _syncing = false;
  var _libView = 'actions'; // 'actions' | 'context'
  var _searchMode = 'action'; // 'action' | 'flow' | 'trigger' | 'connection'
  var _filterTimer = null;
  var LIB_PAGE_SIZE = 200;
  var _libLimit = LIB_PAGE_SIZE; // result-row cap, grows via Show more

  function _capRows(arr) { return arr.length > _libLimit ? arr.slice(0, _libLimit) : arr; }
  function _moreBtn(total) {
    return total > _libLimit
      ? '<button class="btn btn-sm lib-show-more" onclick="LIB._showMore()">Show more (' + (total - _libLimit) + ' hidden)</button>'
      : '';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function logLine(msg, type) {
    if (typeof log === 'function') log(msg, type || 'info');
  }

  // ── Sub-view management ────────────────────────────────────────────────────────

  function _setSubView(view) {
    _libView = view;
    var isCtx = view === 'context';
    var isSp  = view === 'sharepoint';

    ['actions', 'context', 'sharepoint'].forEach(function (v) {
      var btn = document.getElementById('lib-nav-' + v);
      if (btn) btn.classList.toggle('active', v === view);
    });

    var sidebarBtns = document.getElementById('lib-sidebar-btns');
    if (sidebarBtns) sidebarBtns.style.display = (isCtx || isSp) ? 'none' : '';

    var titleEl   = document.getElementById('lib-title');
    var statusEl  = document.getElementById('lib-status');
    var libHeader = document.querySelector('#library-view .lib-header');
    var libBody   = document.getElementById('lib-body');

    if (isCtx) {
      if (titleEl)   { titleEl.innerHTML = icon('lightbulb') + 'Context'; titleEl.style.color = 'var(--text)'; }
      if (statusEl)  { statusEl.textContent = 'App · Team · My · Personal'; statusEl.style.color = 'var(--text3)'; }
      if (libHeader) { libHeader.style.background = 'var(--bg)'; libHeader.style.borderBottomColor = 'var(--border)'; }
      if (libBody)   libBody.style.background = 'var(--bg2)';
    } else if (isSp) {
      if (titleEl)   { titleEl.innerHTML = icon('folder') + 'SharePoint Sites'; titleEl.style.color = 'var(--text)'; }
      if (statusEl)  { statusEl.textContent = 'Cached from last sync'; statusEl.style.color = 'var(--text3)'; }
      if (libHeader) { libHeader.style.background = 'var(--bg)'; libHeader.style.borderBottomColor = 'var(--border)'; }
      if (libBody)   libBody.style.background = 'var(--bg2)';
    } else {
      if (titleEl)   { titleEl.innerHTML = icon('book-open') + 'Actions Library'; titleEl.style.color = ''; }
      if (libHeader) { libHeader.style.background = ''; libHeader.style.borderBottomColor = ''; }
      if (libBody)   libBody.style.background = '';
      updateStatus();
    }
  }

  // ── SharePoint Sites view ─────────────────────────────────────────────────────

  function _renderSiteCard(site, si) {
    var lists    = site.lists || [];
    var siteId   = 'sp-site-' + si;
    var shortUrl = (site.webUrl || '').replace('https://', '');
    return '<div class="lib-result-card">'
      + '<div class="lib-result-header" role="button" tabindex="0" onclick="LIB._spToggle(\'' + siteId + '\')">'
      + '<span class="lib-rc-caret" id="' + siteId + '-caret">▶</span>'
      + '<div class="lib-rc-main">'
      + '<span class="lib-rc-primary">' + esc(site.displayName || 'Unnamed Site') + '</span>'
      + '<span class="lib-rc-connector">'
      + '<a href="' + esc(site.webUrl || '#') + '" target="_blank" rel="noopener" class="lib-sp-link" onclick="event.stopPropagation()">'
      + esc(shortUrl) + '</a></span>'
      + '</div>'
      + '<span class="lib-rc-badge">' + lists.length + ' lists</span>'
      + '</div>'
      + '<div class="lib-result-body" id="' + siteId + '" style="display:none">'
      + (site.id ? '<div class="lib-sp-id-row"><span class="lib-sp-id-label">Site ID</span><span class="lib-sp-id-val">' + esc(site.id) + '</span></div>' : '')
      + lists.map(function (list) {
          var cols = (list.columns || []);
          var colText = cols.slice(0, 8).map(function (c) { return c.displayName || c.name; }).join(' · ')
            + (cols.length > 8 ? ' · +' + (cols.length - 8) + ' more' : '');
          return '<div class="lib-sp-list">'
            + '<div class="lib-sp-list-header">'
            + '<span class="lib-sp-list-name">' + esc(list.displayName || list.name) + '</span>'
            + (list.id ? '<span class="lib-sp-list-id">' + esc(list.id) + '</span>' : '')
            + '</div>'
            + (colText ? '<div class="lib-sp-list-cols">' + esc(colText) + '</div>' : '')
            + '</div>';
        }).join('')
      + '</div>'
      + '</div>';
  }

  async function _renderSharePointView() {
    var body = document.getElementById('lib-body');
    if (!body) return;
    body.innerHTML = '<div class="lib-empty">Loading SharePoint sites…</div>';

    var sites = [];
    try {
      var r = await fetch('/pac/sp/sites');
      var d = await r.json();
      sites = d.sites || [];
    } catch (e) {
      body.innerHTML = '<div class="lib-empty lib-error">Failed to load sites: ' + esc(e.message) + '</div>';
      return;
    }

    var statusEl = document.getElementById('lib-status');
    if (statusEl) {
      var totalLists = sites.reduce(function (n, s) { return n + (s.lists || []).length; }, 0);
      statusEl.textContent = sites.length + ' site(s) · ' + totalLists + ' lists · cached';
    }

    body.innerHTML =
      '<div class="lib-sp-toolbar">'
      + '<button class="btn btn-sm" onclick="LIB._discoverSites()" id="sp-discover-btn">' + icon('search') + 'Discover sites</button>'
      + '<span class="lib-sp-toolbar-sep">or</span>'
      + '<input type="text" id="sp-manual-url" class="lib-sp-url-input" placeholder="Paste site URL…" '
      + 'onkeydown="if(event.key===\'Enter\')LIB._addManualSite()">'
      + '<button class="btn btn-sm" onclick="LIB._addManualSite()" id="sp-manual-btn">+ Add</button>'
      + '</div>'
      + '<div id="sp-discover-panel" style="display:none"></div>'
      + (sites.length
          ? '<div id="sp-sites-list">' + sites.map(_renderSiteCard).join('') + '</div>'
          : '<div class="lib-empty lib-empty-pad">No sites tracked yet — click Discover sites or paste a site URL above.</div>'
        );
  }

  // ── Site discovery flow ───────────────────────────────────────────────────────

  var _discoverResults = [];

  function _discoverSites() {
    var panel = document.getElementById('sp-discover-panel');
    var btn   = document.getElementById('sp-discover-btn');
    if (!panel) return;
    panel.style.display = '';
    panel.innerHTML = '<div class="lib-sp-discover-log" id="sp-disc-log">Contacting Microsoft…</div>';
    if (btn) { btn.disabled = true; btn.innerHTML = icon('search') + 'Discovering…'; }

    var log = function (txt) {
      var el = document.getElementById('sp-disc-log');
      if (el) el.textContent += '\n' + txt;
    };

    fetch('/pac/sp/discover-sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (resp) {
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        function read() {
          reader.read().then(function (chunk) {
            if (chunk.done) {
              if (btn) { btn.disabled = false; btn.innerHTML = icon('search') + 'Discover sites'; }
              return;
            }
            buf += decoder.decode(chunk.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (part) {
              var line = part.replace(/^data: /, '');
              if (!line) return;
              try {
                var ev = JSON.parse(line);
                if (ev.type === 'progress') {
                  log(ev.text.trim());
                } else if (ev.type === 'auth_required') {
                  panel.innerHTML = LIB._renderAuthCard(ev);
                } else if (ev.type === 'auth_pending') {
                  var w = document.querySelector('.lib-auth-waiting');
                  if (w) w.textContent = '⏳ Waiting for authorization… ' + ev.secsLeft + 's remaining';
                } else if (ev.type === 'auth_done') {
                  panel.innerHTML = '<div class="lib-sp-discover-log" id="sp-disc-log">Authorized! Searching sites…</div>';
                } else if (ev.type === 'error') {
                  panel.innerHTML = '<div class="lib-sp-discover-log lib-error">' + esc(ev.message) + '</div>';
                  if (btn) { btn.disabled = false; btn.innerHTML = icon('search') + 'Discover sites'; }
                } else if (ev.type === 'done') {
                  _discoverResults = ev.sites || [];
                  _renderDiscoverResults(panel);
                  if (btn) { btn.disabled = false; btn.innerHTML = icon('search') + 'Discover sites'; }
                }
              } catch {}
            });
            read();
          });
        }
        read();
      })
      .catch(function (e) {
        panel.innerHTML = '<div class="lib-empty lib-error">Discovery failed: ' + esc(e.message) + '</div>';
        if (btn) { btn.disabled = false; btn.innerHTML = icon('search') + 'Discover sites'; }
      });
  }

  function _renderDiscoverResults(panel) {
    var sites = _discoverResults;
    if (!sites.length) {
      panel.innerHTML = '<div class="lib-empty">No sites found via search.</div>';
      return;
    }
    var newSites  = sites.filter(function (s) { return !s.tracked; });
    var doneSites = sites.filter(function (s) { return s.tracked; });

    var html = '<div class="lib-sp-discover-results">'
      + '<div class="lib-sp-disc-summary">'
      + '<strong>' + sites.length + ' site(s) found</strong> — '
      + newSites.length + ' new, ' + doneSites.length + ' already tracked'
      + '</div>';

    if (newSites.length) {
      html += '<div class="lib-sp-disc-section-label">New sites — select to add:</div>'
        + newSites.map(function (s, i) {
            var shortUrl = (s.webUrl || '').replace('https://', '');
            var id = 'sp-disc-chk-' + i;
            return '<label class="lib-sp-disc-row" for="' + id + '">'
              + '<input type="checkbox" id="' + id + '" data-url="' + esc(s.webUrl) + '" data-name="' + esc(s.displayName) + '" checked> '
              + '<span class="lib-sp-disc-name">' + esc(s.displayName || s.webUrl) + '</span>'
              + (s.description ? '<span class="lib-sp-disc-desc">' + esc(s.description) + '</span>' : '')
              + '<span class="lib-sp-disc-url">' + esc(shortUrl) + '</span>'
              + '</label>';
          }).join('');

      html += '<div class="lib-sp-disc-actions">'
        + '<button class="btn btn-primary btn-sm" onclick="LIB._addSelectedSites()">+ Add selected</button>'
        + '<button class="btn btn-sm" onclick="LIB._closeDiscoverPanel()">Cancel</button>'
        + '</div>';
    } else {
      html += '<div class="lib-sp-disc-section-label lib-disc-all-done">✓ All discovered sites are already tracked.</div>';
    }

    if (doneSites.length) {
      html += '<div class="lib-sp-disc-section-label lib-disc-tracked-label">Already tracked:</div>'
        + doneSites.map(function (s) {
            return '<div class="lib-sp-disc-row lib-sp-disc-tracked">'
              + '<span class="lib-sp-disc-name">✓ ' + esc(s.displayName || s.webUrl) + '</span>'
              + '<span class="lib-sp-disc-url">' + esc((s.webUrl || '').replace('https://', '')) + '</span>'
              + '</div>';
          }).join('');
    }

    html += '</div>';
    panel.innerHTML = html;
  }

  function _addSelectedSites() {
    var checkboxes = document.querySelectorAll('#sp-discover-panel input[type=checkbox]:checked');
    if (!checkboxes.length) { toast('No sites selected.','warn'); return; }

    var toAdd = Array.from(checkboxes).map(function (cb) {
      return { webUrl: cb.dataset.url, displayName: cb.dataset.name };
    });

    var panel = document.getElementById('sp-discover-panel');
    var log   = function (txt) { if (panel) panel.innerHTML += '<div class="lib-disc-log-line">' + esc(txt) + '</div>'; };

    if (panel) panel.innerHTML = '<div class="lib-sp-discover-log" id="sp-add-log">Adding ' + toAdd.length + ' site(s)…</div>';

    fetch('/pac/sp/add-sites', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sites: toAdd }),
    }).then(function (resp) {
      var reader  = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf     = '';

      function read() {
        reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += decoder.decode(chunk.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (part) {
            var line = part.replace(/^data: /, '');
            if (!line) return;
            try {
              var ev = JSON.parse(line);
              if (ev.type === 'progress') {
                log(ev.text.trim());
              } else if (ev.type === 'error') {
                log('✗ Error: ' + ev.message);
              } else if (ev.type === 'done') {
                if (panel) {
                  panel.innerHTML += '<div class="lib-disc-done-line">'
                    + '✓ Done — ' + (ev.added || []).length + ' site(s) added. Reloading view…</div>';
                }
                setTimeout(function () { _renderSharePointView(); }, 1000);
              }
            } catch {}
          });
          read();
        });
      }
      read();
    }).catch(function (e) {
      if (panel) panel.innerHTML += '<div class="lib-disc-err-line">Error: ' + esc(e.message) + '</div>';
    });
  }

  function _closeDiscoverPanel() {
    var panel = document.getElementById('sp-discover-panel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  }

  function _addManualSite() {
    var input = document.getElementById('sp-manual-url');
    var btn   = document.getElementById('sp-manual-btn');
    if (!input) return;
    var raw = (input.value || '').trim().replace(/\/$/, '');
    if (!raw) { input.focus(); return; }

    // Accept either full URL or just the path portion
    var webUrl = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;

    // Extract a display name from the URL path (last segment)
    var pathParts = webUrl.replace(/^https?:\/\/[^/]+/i, '').split('/').filter(Boolean);
    var guessedName = pathParts[pathParts.length - 1] || webUrl;

    var panel = document.getElementById('sp-discover-panel');
    if (panel) {
      panel.style.display = '';
      panel.innerHTML = '<div class="lib-sp-discover-log" id="sp-add-log">Fetching lists for ' + esc(webUrl) + '…</div>';
    }
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    input.value = '';

    fetch('/pac/sp/add-sites', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sites: [{ webUrl: webUrl, displayName: guessedName }] }),
    }).then(function (resp) {
      var reader  = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf     = '';
      function read() {
        reader.read().then(function (chunk) {
          if (chunk.done) {
            if (btn) { btn.disabled = false; btn.textContent = '+ Add'; }
            return;
          }
          buf += decoder.decode(chunk.value, { stream: true });
          var parts = buf.split('\n\n'); buf = parts.pop();
          parts.forEach(function (part) {
            var line = part.replace(/^data: /, '');
            if (!line) return;
            try {
              var ev = JSON.parse(line);
              if (ev.type === 'progress' && panel) {
                var logEl = document.getElementById('sp-add-log');
                if (logEl) logEl.textContent += '\n' + ev.text.trim();
              } else if (ev.type === 'error' && panel) {
                panel.innerHTML += '<div class="lib-disc-err-line">✗ ' + esc(ev.message) + '</div>';
              } else if (ev.type === 'done') {
                if (panel) {
                  panel.innerHTML += '<div class="lib-disc-done-line">'
                    + '✓ Done. Reloading…</div>';
                }
                if (btn) { btn.disabled = false; btn.textContent = '+ Add'; }
                setTimeout(function () { _renderSharePointView(); }, 900);
              }
            } catch {}
          });
          read();
        });
      }
      read();
    }).catch(function (e) {
      if (panel) panel.innerHTML += '<div class="lib-disc-err-line">Error: ' + esc(e.message) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = '+ Add'; }
    });
  }

  // ── View management ────────────────────────────────────────────────────────────

  function showView() {
    var content = document.getElementById('content');
    if (content) content.style.display = '';
    document.getElementById('empty-state').style.display    = 'none';
    document.getElementById('solution-view').style.display  = 'none';
    document.getElementById('new-sol-view').style.display   = 'none';
    // Hide the visualizer via VIZ.hide() (class-based), never an inline
    // display:none — an inline style outlives this view and permanently
    // masks #flow-workspace.open, so every later diagram open looks blank.
    if (window.VIZ) VIZ.hide();
    document.getElementById('action-bar').style.display     = 'none';
    document.getElementById('btn-viz-back').style.display   = 'none';
    document.getElementById('btn-pa').style.display         = 'none';
    document.getElementById('library-view').style.display   = 'flex';
    document.getElementById('main-title').textContent       = 'Library';
    document.getElementById('main-ver').textContent         = '';
  }

  // ── Status helper ──────────────────────────────────────────────────────────────

  function updateStatus() {
    var el = document.getElementById('lib-status');
    if (!el) return;
    el.style.color = '';
    if (!_lib) { el.textContent = 'Not loaded'; return; }
    var d = _lib.lastUpdated ? new Date(_lib.lastUpdated).toLocaleDateString() : '?';
    var source = _lib.source === 'sharepoint' ? 'SharePoint' : 'local scan';
    var connCount = Object.keys(_lib.connectors || {}).length;
    el.textContent = connCount + ' connectors · ' + (_lib.flowsScanned || 0) + ' flows · ' + source + ' · ' + d;
  }

  // ── Actions view ──────────────────────────────────────────────────────────────

  function _renderActionsView() {
    var body = document.getElementById('lib-body');
    if (!body) return;

    body.innerHTML = '<div class="lib-filter-bar">'
      + '<input type="search" class="lib-filter-search" id="lib-search" '
      + 'placeholder="Search…" oninput="LIB._filter()" autocomplete="off">'
      + '<div class="lib-mode-pills">'
      + _modePill('action',     icon('zap') + 'By Action')
      + _modePill('flow',       icon('file-text') + 'By Flow')
      + _modePill('trigger',    icon('clock') + 'By Trigger')
      + _modePill('connection', icon('plug') + 'By Connection')
      + _modePill('table',      icon('table') + 'Table')
      + '</div>'
      + '</div>'
      + '<div id="lib-results"></div>';

    _renderResults();
  }

  function _modePill(mode, label) {
    return '<button class="lib-mode-pill' + (_searchMode === mode ? ' active' : '') + '" '
      + 'onclick="LIB._setMode(\'' + mode + '\')">' + label + '</button>';
  }

  // ── Mode switching ─────────────────────────────────────────────────────────────

  window.LIB = window.LIB || {};

  function _setMode(mode) {
    _searchMode = mode;
    _libLimit = LIB_PAGE_SIZE;
    // Update pill states
    document.querySelectorAll('.lib-mode-pill').forEach(function (p) {
      p.classList.toggle('active', p.textContent.trim().includes(_pillLabel(mode)));
    });
    // Update search placeholder
    var searchEl = document.getElementById('lib-search');
    if (searchEl) {
      var hints = {
        action:     'Search operations… e.g. "Send SMS", "HTTP"',
        flow:       'Search flow names or solutions…',
        trigger:    'Search trigger types… e.g. "Recurrence", "HTTP"',
        connection: 'Search connectors… e.g. "SharePoint", "Twilio"',
        table:      'Search everything — action, connector, flow, solution…',
      };
      searchEl.placeholder = hints[mode] || 'Search…';
      searchEl.value = '';
    }
    _renderResults();
  }

  function _pillLabel(mode) {
    return { action: 'By Action', flow: 'By Flow', trigger: 'By Trigger', connection: 'By Connection', table: 'Table' }[mode] || '';
  }

  // ── Result dispatcher ──────────────────────────────────────────────────────────

  function _renderResults() {
    var target = document.getElementById('lib-results');
    if (!target) return;

    if (!_lib || !Object.keys(_lib.connectors || {}).length) {
      target.innerHTML = '<div class="lib-empty">'
        + 'No library loaded yet.<br>'
        + 'Use <strong>⚙ Build from local flows</strong> in the sidebar to index your exported solutions,<br>'
        + 'or <strong>☁ Sync from SharePoint</strong> to fetch the curated library.'
        + '</div>';
      return;
    }

    var q = ((document.getElementById('lib-search') || {}).value || '').toLowerCase().trim();

    if (_searchMode === 'action')     _renderByAction(target, q);
    else if (_searchMode === 'flow')  _renderByFlow(target, q);
    else if (_searchMode === 'trigger') _renderByTrigger(target, q);
    else if (_searchMode === 'table') _renderTableView(target, q);
    else                              _renderByConnection(target, q);
  }

  // ── Table view ────────────────────────────────────────────────────────────
  // Flat, exportable table: one row per action × flow, with the LOCATION of
  // each usage (solution + flow) so it can be exported or found in the cloud.

  function _buildTableRows(q) {
    var rows = [];
    Object.entries(_lib.connectors || {}).forEach(function (pair) {
      var connId = pair[0], conn = pair[1];
      var connName = conn.displayName || connId;
      Object.entries(conn.operations || {}).forEach(function (opPair) {
        var opId = opPair[0], op = opPair[1];
        var flowsSeen = {};
        (op.examples || []).forEach(function (ex) {
          var k = (ex.solution || '') + '|' + (ex.flow || '');
          if (!flowsSeen[k]) {
            flowsSeen[k] = true;
            rows.push({ action: opId, connector: connName, flow: ex.flow || '', solution: ex.solution || '', actionName: ex.actionName || '', count: op.count });
          }
        });
        if (!(op.examples || []).length) {
          rows.push({ action: opId, connector: connName, flow: '', solution: '', actionName: '', count: op.count });
        }
      });
    });
    if (q) {
      rows = rows.filter(function (r) {
        return (r.action + ' ' + r.connector + ' ' + r.flow + ' ' + r.solution + ' ' + r.actionName).toLowerCase().includes(q);
      });
    }
    rows.sort(function (a, b) {
      return a.connector.localeCompare(b.connector) || a.action.localeCompare(b.action) || a.solution.localeCompare(b.solution);
    });
    return rows;
  }

  function _renderTableView(target, q) {
    var rows = _buildTableRows(q);
    if (!rows.length) {
      target.innerHTML = '<div class="lib-empty">No actions match your search.</div>';
      return;
    }
    var body = _capRows(rows).map(function (r) {
      return '<tr>'
        + '<td class="lib-tbl-action">' + esc(r.action) + (r.actionName ? '<span class="lib-tbl-step" title="Step name inside the flow">' + esc(r.actionName) + '</span>' : '') + '</td>'
        + '<td>' + esc(r.connector) + '</td>'
        + '<td>' + (r.flow ? esc(r.flow) : '<span class="lib-tbl-none">—</span>') + '</td>'
        + '<td class="lib-tbl-sol">' + (r.solution ? esc(r.solution) : '<span class="lib-tbl-none">—</span>') + '</td>'
        + '<td class="lib-tbl-count">' + r.count + '</td>'
        + '</tr>';
    }).join('');
    target.innerHTML =
      '<div class="lib-tbl-toolbar">'
      + '<span class="lib-tbl-summary">' + rows.length + ' result' + (rows.length === 1 ? '' : 's') + ' — solution + flow tell you where to export or find each action in the cloud</span>'
      + '<button class="btn btn-sm" onclick="LIB._exportCsv()">' + icon('download') + 'Export CSV</button>'
      + '</div>'
      + '<div class="lib-tbl-wrap"><table class="lib-tbl">'
      + '<thead><tr><th>Action</th><th>Connector</th><th>Flow</th><th>Solution</th><th>Uses</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table></div>'
      + _moreBtn(rows.length);
  }

  // ── By Action ─────────────────────────────────────────────────────────────────
  // Flat list of operations, grouped by connector name, filtered by query.
  // Each row shows the flow examples on expand.

  function _renderByAction(target, q) {
    var rows = [];

    Object.entries(_lib.connectors || {}).forEach(function (pair) {
      var connId = pair[0], conn = pair[1];
      var connName = conn.displayName || connId;
      Object.entries(conn.operations || {}).forEach(function (opPair) {
        var opId = opPair[0], op = opPair[1];
        var text = (connName + ' ' + opId).toLowerCase();
        if (q && !text.includes(q)) return;

        // Collect unique flows
        var flowsSeen = {};
        (op.examples || []).forEach(function (ex) {
          var k = ex.solution + '|' + ex.flow;
          if (!flowsSeen[k]) flowsSeen[k] = ex;
        });
        var flows = Object.values(flowsSeen);

        rows.push({ connId, connName, opId, op, flows });
      });
    });

    rows.sort(function (a, b) { return b.op.count - a.op.count; });

    if (!rows.length) {
      target.innerHTML = '<div class="lib-empty">No actions match your search.</div>';
      return;
    }

    target.innerHTML = _capRows(rows).map(function (r) {
      var safeKey = (r.connId + '_' + r.opId).replace(/[^a-z0-9_-]/gi, '_');
      var flowList = r.flows.map(function (ex) {
        return '<div class="lib-result-flow">'
          + '<span class="lib-rf-name">' + esc(ex.flow) + '</span>'
          + '<span class="lib-rf-sol">' + esc(ex.solution) + '</span>'
          + '</div>';
      }).join('');

      return '<div class="lib-result-card" id="lra_' + safeKey + '">'
        + '<div class="lib-result-header" role="button" tabindex="0" onclick="LIB._toggleResult(\'lra_' + safeKey + '\')">'
        + '<span class="lib-rc-caret">▶</span>'
        + '<div class="lib-rc-main">'
        + '<span class="lib-rc-primary">' + esc(r.opId) + '</span>'
        + '<span class="lib-rc-connector">' + esc(r.connName) + '</span>'
        + '</div>'
        + '<span class="lib-rc-badge">' + r.op.count + ' use' + (r.op.count === 1 ? '' : 's')
        + ' · ' + r.flows.length + ' flow' + (r.flows.length === 1 ? '' : 's') + '</span>'
        + '</div>'
        + '<div class="lib-result-body" style="display:none">'
        + (r.flows.length ? flowList : '<div class="lib-rf-empty">No flow examples indexed.</div>')
        + '</div>'
        + '</div>';
    }).join('') + _moreBtn(rows.length);
  }

  // ── By Flow ───────────────────────────────────────────────────────────────────
  // One card per flow, showing its trigger and which connectors it uses.

  function _renderByFlow(target, q) {
    var flows;

    if (_lib.flows && Object.keys(_lib.flows).length) {
      // Use the full flow index from bridge (built during local scan)
      flows = Object.values(_lib.flows);
    } else {
      // Fallback: reconstruct from operation examples (partial — capped at 5/op)
      var seen = {};
      Object.entries(_lib.connectors || {}).forEach(function (pair) {
        var connId = pair[0], conn = pair[1];
        Object.values(conn.operations || {}).forEach(function (op) {
          (op.examples || []).forEach(function (ex) {
            var k = ex.solution + '|' + ex.flow;
            if (!seen[k]) seen[k] = { solution: ex.solution, flow: ex.flow, trigger: null, connectors: [] };
            var fc = seen[k].connectors;
            var entry = fc.find(function (c) { return c.connectorId === connId; });
            if (entry) {
              if (!entry.operations.includes(pair[1])) entry.operations.push('');
              entry.count++;
            } else {
              fc.push({ connectorId: connId, displayName: conn.displayName || connId, operations: [], count: 1 });
            }
          });
        });
      });
      flows = Object.values(seen);
    }

    if (q) {
      flows = flows.filter(function (f) {
        return (f.flow + ' ' + f.solution).toLowerCase().includes(q);
      });
    }

    flows.sort(function (a, b) {
      var ca = (a.connectors || []).reduce(function (s, c) { return s + c.count; }, 0);
      var cb = (b.connectors || []).reduce(function (s, c) { return s + c.count; }, 0);
      return cb - ca;
    });

    if (!flows.length) {
      var hint = !_lib.flows ? ' (rebuild the library locally to get the full flow index)' : '';
      target.innerHTML = '<div class="lib-empty">No flows match your search.' + hint + '</div>';
      return;
    }

    target.innerHTML = _capRows(flows).map(function (f) {
      var safeKey = (f.solution + '_' + f.flow).replace(/[^a-z0-9_-]/gi, '_');
      var connList = (f.connectors || [])
        .sort(function (a, b) { return b.count - a.count; })
        .map(function (c) {
          return '<div class="lib-result-flow">'
            + '<span class="lib-rf-name">' + esc(c.displayName) + '</span>'
            + '<span class="lib-rf-sol">' + (c.operations || []).slice(0, 4).map(esc).join(', ') + '</span>'
            + '<span class="lib-rf-badge">×' + c.count + '</span>'
            + '</div>';
        }).join('');

      var trigBadge = f.trigger
        ? '<span class="lib-rc-trigger">' + esc(f.trigger) + '</span>'
        : '';

      return '<div class="lib-result-card" id="lrf_' + safeKey + '">'
        + '<div class="lib-result-header" role="button" tabindex="0" onclick="LIB._toggleResult(\'lrf_' + safeKey + '\')">'
        + '<span class="lib-rc-caret">▶</span>'
        + '<div class="lib-rc-main">'
        + '<span class="lib-rc-primary">' + esc(f.flow) + '</span>'
        + '<span class="lib-rc-connector">' + esc(f.solution) + '</span>'
        + '</div>'
        + trigBadge
        + '<span class="lib-rc-badge">' + (f.connectors || []).length + ' connector' + ((f.connectors || []).length === 1 ? '' : 's') + '</span>'
        + '</div>'
        + '<div class="lib-result-body" style="display:none">'
        + (connList || '<div class="lib-rf-empty">No connectors indexed for this flow.</div>')
        + '</div>'
        + '</div>';
    }).join('') + _moreBtn(flows.length);
  }

  // ── By Trigger ────────────────────────────────────────────────────────────────
  // Grouped by trigger type, showing all flows with that trigger.

  function _renderByTrigger(target, q) {
    if (!_lib.triggers || !Object.keys(_lib.triggers).length) {
      target.innerHTML = '<div class="lib-empty">'
        + 'Trigger index not available in this library.<br>'
        + 'Click <strong>⚙ Build from local flows</strong> in the sidebar to rebuild with trigger data.'
        + '</div>';
      return;
    }

    var entries = Object.entries(_lib.triggers);

    if (q) {
      entries = entries.filter(function (pair) {
        return pair[0].toLowerCase().includes(q);
      });
    }

    entries.sort(function (a, b) { return b[1].count - a[1].count; });

    if (!entries.length) {
      target.innerHTML = '<div class="lib-empty">No trigger types match your search.</div>';
      return;
    }

    target.innerHTML = _capRows(entries).map(function (pair) {
      var label = pair[0], trig = pair[1];
      var safeKey = label.replace(/[^a-z0-9_-]/gi, '_');
      var flowList = (trig.flows || []).map(function (f) {
        return '<div class="lib-result-flow">'
          + '<span class="lib-rf-name">' + esc(f.flow) + '</span>'
          + '<span class="lib-rf-sol">' + esc(f.solution) + '</span>'
          + '</div>';
      }).join('');

      return '<div class="lib-result-card" id="lrt_' + safeKey + '">'
        + '<div class="lib-result-header" role="button" tabindex="0" onclick="LIB._toggleResult(\'lrt_' + safeKey + '\')">'
        + '<span class="lib-rc-caret">▶</span>'
        + '<div class="lib-rc-main">'
        + '<span class="lib-rc-primary">' + esc(label) + '</span>'
        + '</div>'
        + '<span class="lib-rc-badge">' + trig.count + ' flow' + (trig.count === 1 ? '' : 's') + '</span>'
        + '</div>'
        + '<div class="lib-result-body" style="display:none">'
        + (flowList || '<div class="lib-rf-empty">No flows indexed.</div>')
        + '</div>'
        + '</div>';
    }).join('') + _moreBtn(entries.length);
  }

  // ── By Connection ─────────────────────────────────────────────────────────────
  // Original connector accordion — browse all connectors → operations → examples.

  function _renderByConnection(target, q) {
    var connectors = Object.entries(_lib.connectors || {});

    if (q) {
      connectors = connectors.filter(function (pair) {
        var id = pair[0], c = pair[1];
        if ((c.displayName || id).toLowerCase().includes(q)) return true;
        return Object.keys(c.operations || {}).some(function (op) {
          return op.toLowerCase().includes(q);
        });
      });
    }

    connectors.sort(function (a, b) { return b[1].count - a[1].count; });

    if (!connectors.length) {
      target.innerHTML = '<div class="lib-empty">No connectors match your search.</div>';
      return;
    }

    target.innerHTML = _capRows(connectors).map(function (pair) {
      var id = pair[0], c = pair[1];
      var ops = Object.entries(c.operations || {}).sort(function (a, b) { return b[1].count - a[1].count; });
      var safeId = id.replace(/[^a-z0-9_-]/gi, '_');

      return '<div class="lib-connector" id="libcon_' + safeId + '">'
        + '<div class="lib-connector-header" role="button" tabindex="0" onclick="LIB._toggle(\'' + safeId + '\')">'
        + '<span class="lib-connector-caret">▶</span>'
        + '<span class="lib-connector-name">' + esc(c.displayName || id) + '</span>'
        + '<span class="lib-connector-badge">' + c.count + ' uses</span>'
        + '<span class="lib-ops-count">' + ops.length + ' operation' + (ops.length === 1 ? '' : 's') + '</span>'
        + '</div>'
        + '<div class="lib-connector-body" style="display:none">'
        + (ops.length ? ops.map(function (opPair) {
          var opId = opPair[0], op = opPair[1];
          var safeOpId = opId.replace(/[^a-z0-9_-]/gi, '_');
          return '<div class="lib-op">'
            + '<div class="lib-op-header" role="button" tabindex="0" onclick="LIB._toggleOp(\'' + safeId + '\',\'' + safeOpId + '\')">'
            + '<span class="lib-op-caret">▶</span>'
            + '<span class="lib-op-name">' + esc(opId) + '</span>'
            + '<span class="lib-op-badge">×' + op.count + '</span>'
            + '</div>'
            + '<div class="lib-op-body" id="libop_' + safeId + '_' + safeOpId + '" style="display:none">'
            + (op.examples || []).slice(0, 3).map(function (ex) {
              var snippet = '';
              try { snippet = JSON.stringify(ex.snippet, null, 2).slice(0, 900); } catch (_) {}
              return '<div class="lib-example">'
                + '<div class="lib-example-meta">'
                + esc(ex.solution || '') + ' › ' + esc(ex.flow || '') + ' › <code>' + esc(ex.actionName || '') + '</code>'
                + '</div>'
                + (snippet ? '<pre class="lib-example-code">' + esc(snippet) + (snippet.length >= 900 ? '\n…' : '') + '</pre>' : '')
                + '</div>';
            }).join('')
            + '</div></div>';
        }).join('') : '<div class="lib-empty lib-empty-tight">No operations indexed.</div>')
        + '</div></div>';
    }).join('') + _moreBtn(connectors.length);
  }

  // ── Toggle helpers ─────────────────────────────────────────────────────────────

  function _toggleEl(el) {
    if (!el) return;
    var body = el.querySelector('.lib-result-body, .lib-connector-body');
    var caret = el.querySelector('.lib-rc-caret, .lib-connector-caret');
    if (!body) return;
    var open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (caret) caret.textContent = open ? '▶' : '▼';
  }

  // ── Public API ─────────────────────────────────────────────────────────────────

  window.LIB = {

    open: async function () {
      showView();
      logLine('Library view opened', 'info');

      var loadErr = null;
      try {
        var r = await fetch('/pac/library');
        if (r.ok) {
          var data = await r.json();
          if (data && data.connectors) {
            _lib = data;
            var connCount = Object.keys(_lib.connectors).length;
            logLine('Library loaded from cache — ' + connCount + ' connectors, ' + (_lib.flowsScanned || 0) + ' flows (' + (_lib.source === 'sharepoint' ? 'SharePoint' : 'local scan') + ')', 'ok');
          } else {
            logLine('No library cached yet — use Sync from SharePoint or Build from local flows', 'info');
          }
        } else {
          loadErr = 'HTTP ' + r.status;
        }
      } catch (e) {
        loadErr = e.message;
        logLine('Could not load cached library: ' + e.message, 'warn');
      }
      if (loadErr && !_lib) {
        var bodyEl = document.getElementById('lib-body');
        if (bodyEl) bodyEl.innerHTML = '<div class="panel-error">'
          + '<span class="panel-error-msg">Couldn\'t load the cached library — ' + esc(loadErr) + '</span>'
          + '<button class="btn btn-sm" onclick="LIB.open()">↺ Retry</button>'
          + '</div>';
        var st = document.getElementById('lib-status');
        if (st) st.textContent = 'Load failed';
        return;
      }

      _setSubView(_libView);
      if (_libView === 'context') {
        await LIB._renderContext();
      } else {
        _renderActionsView();
      }
    },

    close: function () {
      var lv = document.getElementById('library-view');
      if (lv) lv.style.display = 'none';
    },

    selectView: async function (view) {
      _setSubView(view);
      if (view === 'context') {
        await LIB._renderContext();
      } else if (view === 'sharepoint') {
        await _renderSharePointView();
      } else {
        _renderActionsView();
      }
    },

    _spToggle: function (id) {
      var b = document.getElementById(id);
      var c = document.getElementById(id + '-caret');
      if (!b) return;
      var open = b.style.display !== 'none';
      b.style.display = open ? 'none' : '';
      if (c) { c.textContent = open ? '▶' : '▼'; }
    },

    _discoverSites:      function () { _discoverSites(); },
    _addSelectedSites:   function () { _addSelectedSites(); },
    _closeDiscoverPanel: function () { _closeDiscoverPanel(); },
    _addManualSite:      function () { _addManualSite(); },

    switchTab: async function (tab) { return LIB.selectView(tab); },

    _setMode: function (mode) { _setMode(mode); },

    // Debounced — search re-renders the full result list, so don't do it per keystroke
    _filter: function () {
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(function () {
        _libLimit = LIB_PAGE_SIZE;
        _renderResults();
      }, 150);
    },

    _showMore: function () {
      _libLimit += LIB_PAGE_SIZE;
      _renderResults();
    },

    // Download the current Table-view results as CSV
    _exportCsv: function () {
      var q = ((document.getElementById('lib-search') || {}).value || '').toLowerCase().trim();
      var rows = _buildTableRows(q);
      var csv = [['Action', 'Connector', 'Flow', 'Solution', 'Step name', 'Uses']]
        .concat(rows.map(function (r) { return [r.action, r.connector, r.flow, r.solution, r.actionName, r.count]; }))
        .map(function (cols) {
          return cols.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
        })
        .join('\r\n');
      // VS Code webview: Blob/anchor downloads are unreliable in the sandbox,
      // so the CSV is saved host-side via a save dialog (see libraryPanel.ts).
      var filename = 'dxt-library-actions' + (q ? '-' + q.replace(/[^a-z0-9]+/g, '_') : '') + '.csv';
      window.bridge.request('/pac/save-csv', { csv: csv, filename: filename }).then(function (reply) {
        if (reply.ok && reply.data && reply.data.saved) {
          if (typeof toast === 'function') toast('Exported ' + rows.length + ' rows', 'ok');
          logLine('Exported ' + rows.length + ' library rows to CSV', 'ok');
        } else if (reply.ok && reply.data && reply.data.cancelled) {
          logLine('CSV export cancelled', 'info');
        } else {
          if (typeof toast === 'function') toast('CSV export failed: ' + ((reply.data && reply.data.error) || reply.error || 'unknown'), 'err');
        }
      });
    },

    // Read-only access to the cached library index (command palette, search)
    getIndex: function () { return _lib; },

    // Jump to the Actions view with a search term pre-filled
    searchFor: function (q) {
      _libView = 'actions';
      _searchMode = 'action';
      showView();
      _setSubView('actions');
      _renderActionsView();
      var input = document.getElementById('lib-search');
      if (input) { input.value = q || ''; _renderResults(); input.focus(); }
    },

    _toggleResult: function (id) {
      _toggleEl(document.getElementById(id));
    },

    _toggle: function (safeId) {
      _toggleEl(document.getElementById('libcon_' + safeId));
    },

    _toggleOp: function (safeId, safeOpId) {
      var el = document.getElementById('libop_' + safeId + '_' + safeOpId);
      if (!el) return;
      var open = el.style.display !== 'none';
      el.style.display = open ? 'none' : '';
      var hdr = el.previousElementSibling;
      if (hdr) { var c = hdr.querySelector('.lib-op-caret'); if (c) c.textContent = open ? '▶' : '▼'; }
    },

    // ── Config form ────────────────────────────────────────────────────────────
    showConfig: async function (prefill) {
      var cfg = prefill || {};
      var statusEl = document.getElementById('lib-status');
      if (statusEl) statusEl.textContent = 'Loading config…';
      logLine('Opening SharePoint connection config', 'info');

      try {
        var r = await fetch('/pac/sp-config');
        if (r.ok) { var d = await r.json(); if (d.ok) cfg = Object.assign(d, cfg); }
      } catch (_) {}

      if (cfg.detectedTenant && !cfg.tenantId) {
        logLine('Tenant ID auto-detected from pac auth: ' + cfg.detectedTenant, 'ok');
      }

      var body = document.getElementById('lib-body');
      if (!body) return;
      if (statusEl) statusEl.textContent = 'Setup required';

      var tenantVal = cfg.tenantId || cfg.detectedTenant || '';
      var tenantHint = (cfg.detectedTenant && cfg.detectedTenant === tenantVal)
        ? '<span class="lib-config-hint lib-config-detected">✓ Auto-detected from pac auth</span>'
        : (cfg.detectedTenant
            ? '<span class="lib-config-hint lib-config-detected">Detected from pac: ' + esc(cfg.detectedTenant)
              + ' <button class="lib-config-use-btn" onclick="document.getElementById(\'sp-tenant-id\').value=\'' + esc(cfg.detectedTenant) + '\'">Use this</button></span>'
            : '');

      var hasToken = cfg.hasToken
        ? '<span class="lib-token-ok">✅ Token cached — next sync skips authorization</span>'
        : '<span class="lib-token-none">○ No token saved yet — authorization required on first sync</span>';

      body.innerHTML = '<div class="lib-config-card">'
        + '<div class="lib-config-title">SharePoint Connection — SA-DXTPowerAutomate-Prod</div>'
        + '<p class="lib-config-desc">'
        + 'Uses <strong>SA-DXTPowerAutomate-Prod</strong> with <strong>Allow public client flows</strong> enabled. '
        + 'No client secret required — device code sign-in completes as a public client. '
        + 'Scope: SharePoint <code>user_impersonation</code> (no admin consent needed).'
        + '</p>'
        + '<div class="lib-config-row"><label>Tenant ID</label>'
        + '<input class="lib-config-input" id="sp-tenant-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="' + esc(tenantVal) + '">'
        + tenantHint + '</div>'
        + '<div class="lib-config-row"><label>Client ID</label>'
        + '<input class="lib-config-input" id="sp-client-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="">'
        + '<span class="lib-config-hint">' + esc(cfg.clientId || 'Not set') + '</span></div>'
        + '<div class="lib-config-row"><label>Client Secret <span class="lib-config-optional">optional</span></label>'
        + '<input class="lib-config-input" id="sp-client-secret" type="password" placeholder="Leave blank — not required" value="">'
        + '<span class="lib-config-hint">' + (cfg.hasSecret ? '● Saved (leave blank to keep)' : 'Not set') + '</span></div>'
        + '<div class="lib-config-row"><label>SharePoint domain</label>'
        + '<input class="lib-config-input" id="sp-site-domain" value="' + esc(cfg.siteDomain || 'prepaypower.sharepoint.com') + '"></div>'
        + '<div class="lib-config-row"><label>Site path</label>'
        + '<input class="lib-config-input" id="sp-site-path" value="' + esc(cfg.sitePath || '/sites/Omni-ChannelToolIntegration') + '"></div>'
        + '<div class="lib-config-row"><label>Library file path</label>'
        + '<input class="lib-config-input" id="sp-file-path" value="' + esc(cfg.filePath || 'Shared Documents/DXT Power Automate Toolkit/pa-library.json') + '"></div>'
        + '<div class="lib-config-token">' + hasToken + '</div>'
        + '<div class="lib-config-actions">'
        + '<button class="btn btn-primary" onclick="LIB._saveConfig()">Save &amp; Sync</button>'
        + '<button class="btn" onclick="LIB.selectView(\'actions\')">Cancel</button>'
        + '</div></div>';
    },

    _saveConfig: async function () {
      var tenantId     = (document.getElementById('sp-tenant-id')     || {}).value || '';
      var clientId     = (document.getElementById('sp-client-id')     || {}).value || '';
      var clientSecret = (document.getElementById('sp-client-secret') || {}).value || '';
      var siteDomain   = (document.getElementById('sp-site-domain')   || {}).value || '';
      var sitePath     = (document.getElementById('sp-site-path')     || {}).value || '';
      var filePath     = (document.getElementById('sp-file-path')     || {}).value || '';

      if (!tenantId) { logLine('Config save failed — Tenant ID is required', 'err'); toast('Tenant ID is required','err'); return; }

      var cfg = { tenantId, siteDomain, sitePath, filePath };
      if (clientId)     cfg.clientId     = clientId;
      if (clientSecret) cfg.clientSecret = clientSecret;

      try {
        logLine('Saving SharePoint config…', 'info');
        await fetch('/pac/sp-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
        logLine('SharePoint config saved — tenant: ' + tenantId.slice(0, 8) + '…', 'ok');
      } catch (e) {
        logLine('Config save error: ' + e.message, 'err');
        toast('Config save failed: ' + e.message,'err');
        return;
      }
      LIB.sync();
    },

    // ── Sync from SharePoint ──────────────────────────────────────────────────
    sync: function () {
      if (_syncing) return;
      _syncing = true;

      logLine('SharePoint library sync started…', 'info');
      var btn = document.getElementById('lib-sync-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = icon('cloud') + 'Syncing…'; }
      var statusEl = document.getElementById('lib-status');
      if (statusEl) statusEl.textContent = 'Connecting to Microsoft Graph…';
      var body = document.getElementById('lib-body');
      if (body) body.innerHTML = '<div class="lib-empty lib-empty-roomy">Contacting Microsoft Graph API…</div>';

      fetch('/pac/sync-library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (resp) {
          var reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buf = '';

          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return;
              buf += decoder.decode(chunk.value, { stream: true });
              var lines = buf.split('\n'); buf = lines.pop();

              for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.startsWith('data: ')) continue;
                var ev; try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }

                if (ev.type === 'config_required') {
                  _syncing = false;
                  if (btn) { btn.disabled = false; btn.innerHTML = icon('cloud') + 'Sync from SharePoint'; }
                  if (statusEl) statusEl.textContent = 'Setup required';
                  logLine('SharePoint not configured — opening setup form', 'warn');
                  LIB.showConfig();
                } else if (ev.type === 'auth_required') {
                  if (statusEl) statusEl.textContent = 'Waiting for Microsoft authorization…';
                  logLine('Microsoft authorization required — device code: ' + (ev.user_code || ''), 'warn');
                  logLine('Open ' + (ev.verification_uri || 'microsoft.com/devicelogin') + ' and enter the code', 'info');
                  if (body) body.innerHTML = LIB._renderAuthCard(ev);
                } else if (ev.type === 'auth_pending') {
                  var waiting = document.querySelector('.lib-auth-waiting');
                  if (waiting && ev.secsLeft) waiting.textContent = '⏳ Waiting for authorization… ' + ev.secsLeft + 's remaining';
                } else if (ev.type === 'auth_done') {
                  if (statusEl) statusEl.textContent = 'Authorized ✓ Downloading library…';
                  logLine('Microsoft authorization successful — fetching pa-library.json', 'ok');
                  if (body) body.innerHTML = '<div class="lib-empty">Authorized ✓ Downloading pa-library.json from SharePoint…</div>';
                } else if (ev.type === 'progress') {
                  var plog = document.getElementById('lib-progress-log');
                  if (plog) { plog.textContent += ev.text; plog.scrollTop = plog.scrollHeight; }
                  var trimmed = ev.text ? ev.text.trim() : '';
                  if (trimmed) {
                    logLine(trimmed, 'info');
                    if (statusEl) statusEl.textContent = trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
                  }
                } else if (ev.type === 'done') {
                  _lib = ev.lib;
                  var connCount = Object.keys(_lib.connectors || {}).length;
                  var opCount = Object.values(_lib.connectors || {}).reduce(function (s, c) { return s + Object.keys(c.operations || {}).length; }, 0);
                  logLine('Library synced from SharePoint — ' + connCount + ' connectors, ' + opCount + ' operations, ' + (_lib.flowsScanned || 0) + ' flows scanned', 'ok');
                  toast('Library synced — ' + connCount + ' connectors', 'ok');
                  updateStatus();
                  _renderActionsView();
                } else if (ev.type === 'error') {
                  logLine('Library sync failed: ' + ev.message, 'err');
                  if (statusEl) statusEl.textContent = 'Sync failed';
                  if (body) body.innerHTML = '<div class="lib-empty lib-error">⚠ ' + esc(ev.message)
                    + '<br><br><button class="btn btn-sm" onclick="LIB.sync()">↺ Retry sync</button> '
                    + '<button class="btn btn-sm" onclick="LIB.showConfig()">⚙ Configure SharePoint</button></div>';
                }
              }
              return pump();
            });
          }
          return pump();
        })
        .catch(function (e) {
          logLine('Library sync network error: ' + e.message, 'err');
          if (statusEl) statusEl.textContent = 'Network error';
          if (body) body.innerHTML = '<div class="lib-empty lib-error">Network error: ' + esc(e.message) + '</div>';
        })
        .finally(function () {
          _syncing = false;
          if (btn) { btn.disabled = false; btn.innerHTML = icon('cloud') + 'Sync from SharePoint'; }
        });
    },

    _renderAuthCard: function (ev) {
      return '<div class="lib-auth-card">'
        + '<div class="lib-auth-title">🔐 Microsoft Authorization Required</div>'
        + '<div class="lib-auth-steps">'
        + '<div class="lib-auth-step">1. Copy this code:</div>'
        + '<div class="lib-auth-code-row"><span class="lib-auth-code" id="lib-auth-code">' + esc(ev.user_code || '') + '</span>'
        + '<button class="btn btn-sm" onclick="LIB._copyCode()">Copy</button></div>'
        + '<div class="lib-auth-step">2. Open this URL in your browser:</div>'
        + '<a class="lib-auth-link" href="' + esc(ev.verification_uri || 'https://microsoft.com/devicelogin') + '" target="_blank">'
        + esc(ev.verification_uri || 'https://microsoft.com/devicelogin') + '</a>'
        + '<div class="lib-auth-step">3. Enter the code and sign in with your Microsoft 365 account</div>'
        + '</div>'
        + '<div class="lib-auth-waiting">⏳ Waiting for you to complete authorization in the browser…</div>'
        + '<div id="lib-progress-log" class="lib-progress" style="display:none"></div>'
        + '</div>';
    },

    _copyCode: function () {
      var el = document.getElementById('lib-auth-code');
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(function () {
        var btn = el.nextElementSibling;
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy'; }, 2000); }
        logLine('Authorization code copied to clipboard: ' + el.textContent, 'info');
      }).catch(function () {
        logLine('Copy failed — manually copy the code: ' + el.textContent, 'warn');
      });
    },

    // ── Push library to SharePoint ────────────────────────────────────────────
    push: function () {
      var btn = document.getElementById('lib-push-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = icon('upload-cloud') + 'Pushing…'; }
      var statusEl = document.getElementById('lib-status');
      if (statusEl) statusEl.textContent = 'Uploading to SharePoint…';
      logLine('Pushing library to SharePoint…', 'info');

      fetch('/pac/push-library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (resp) {
          var reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buf = '';

          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return;
              buf += decoder.decode(chunk.value, { stream: true });
              var lines = buf.split('\n'); buf = lines.pop();
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.startsWith('data: ')) continue;
                var ev; try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }

                if (ev.type === 'config_required') {
                  logLine('SharePoint not configured — opening setup form', 'warn'); LIB.showConfig();
                } else if (ev.type === 'auth_required') {
                  logLine('Microsoft authorization required — device code: ' + (ev.user_code || ''), 'warn');
                  var b = document.getElementById('lib-body'); if (b) b.innerHTML = LIB._renderAuthCard(ev);
                } else if (ev.type === 'auth_pending') {
                  var w = document.querySelector('.lib-auth-waiting');
                  if (w && ev.secsLeft) w.textContent = '⏳ Waiting for authorization… ' + ev.secsLeft + 's remaining';
                } else if (ev.type === 'auth_done') {
                  if (statusEl) statusEl.textContent = 'Authorized ✓ Uploading…';
                  logLine('Microsoft authorization successful — uploading library', 'ok');
                } else if (ev.type === 'progress') {
                  var t = ev.text ? ev.text.trim() : ''; if (t) logLine(t, 'info');
                } else if (ev.type === 'done') {
                  logLine('Library pushed to SharePoint — ' + (ev.connCount || 0) + ' connectors, ' + (ev.opCount || 0) + ' operations, ' + (ev.flowsScanned || 0) + ' flows shared with team', 'ok');
                  updateStatus();
                } else if (ev.type === 'error') {
                  logLine('Push failed: ' + ev.message, 'err');
                  if (statusEl) statusEl.textContent = 'Push failed';
                }
              }
              return pump();
            });
          }
          return pump();
        })
        .catch(function (e) { logLine('Push network error: ' + e.message, 'err'); })
        .finally(function () { if (btn) { btn.disabled = false; btn.innerHTML = icon('upload-cloud') + 'Push to SharePoint'; } });
    },

    // ── Context Manager ───────────────────────────────────────────────────────
    _renderContext: async function () {
      var body = document.getElementById('lib-body');
      if (!body) return;
      body.innerHTML = '<div class="lib-empty">Loading context…</div>';

      var appContext = [], custom = {}, personal = {};
      try {
        var r = await fetch('/pac/context');
        if (r.ok) {
          var d = await r.json();
          appContext = d.appContext || [];
          custom     = d.custom    || {};
          personal   = d.personal  || {};
        }
      } catch (e) { logLine('Context load failed: ' + e.message, 'err'); }

      body.innerHTML = [
        '<div class="ctx-section">',
          '<div class="ctx-section-header" role="button" tabindex="0" onclick="LIB._ctxToggle(\'ctx-app\')">',
            '<span class="ctx-caret" id="ctx-app-caret">▶</span>',
            '<span class="ctx-section-title">App Context</span>',
            '<span class="ctx-section-hint">Read-only · CLAUDE.md and cloud-index.md synced from SharePoint</span>',
          '</div>',
          '<div class="ctx-section-body" id="ctx-app" style="display:none">',
            appContext.length ? appContext.map(function (f) {
              return '<div class="ctx-file"><div class="ctx-file-name">' + esc(f.file) + '</div>'
                + '<pre class="ctx-file-content">' + esc((f.content || '').slice(0, 3000))
                + (f.content && f.content.length > 3000 ? '\n…(truncated)' : '') + '</pre></div>';
            }).join('') : '<div class="ctx-empty">No context files found. Sync from SharePoint or check OneDrive sync.</div>',
          '</div>',
        '</div>',
        '<div class="ctx-section">',
          '<div class="ctx-section-header" role="button" tabindex="0" onclick="LIB._ctxToggle(\'ctx-team\')">',
            '<span class="ctx-caret" id="ctx-team-caret">▶</span>',
            '<span class="ctx-section-title">Team Context</span>',
            '<span class="ctx-section-hint">Read-only · Org, team, and environment info</span>',
          '</div>',
          '<div class="ctx-section-body" id="ctx-team" style="display:none">',
            '<div class="ctx-team-grid">',
              '<div class="ctx-team-card"><div class="ctx-team-card-title">Company</div>',
                '<div class="ctx-team-item">Yuno Energy Group</div>',
                '<div class="ctx-team-item ctx-muted">PrepayPower · Yuno Energy · Yuno Energy Heat · Firmus</div></div>',
              '<div class="ctx-team-card"><div class="ctx-team-card-title">Team</div>',
                '<div class="ctx-team-item">Pedro Moreira — PA flows, SQL, Power BI, bots</div>',
                '<div class="ctx-team-item">Barry Hennigan — 8x8, IVR, CX tooling</div>',
                '<div class="ctx-team-item">Mark Bethel — Full generalist</div>',
                '<div class="ctx-team-item">Geoff Keenan — DT Manager</div></div>',
              '<div class="ctx-team-card"><div class="ctx-team-card-title">Environments</div>',
                '<div class="ctx-team-item">🔵 Development - DTA</div>',
                '<div class="ctx-team-item">🟡 Test - DTA</div>',
                '<div class="ctx-team-item">🟢 Production - DTA</div></div>',
              '<div class="ctx-team-card"><div class="ctx-team-card-title">Stack</div>',
                '<div class="ctx-team-item">Power Automate · Copilot Studio</div>',
                '<div class="ctx-team-item">SharePoint · 8x8 · SQL Server</div>',
                '<div class="ctx-team-item">HappyFox · LivePerson · Power BI</div></div>',
            '</div>',
          '</div>',
        '</div>',
        '<div class="ctx-section ctx-section-open">',
          '<div class="ctx-section-header" role="button" tabindex="0" onclick="LIB._ctxToggle(\'ctx-my\')">',
            '<span class="ctx-caret open" id="ctx-my-caret">▼</span>',
            '<span class="ctx-section-title">My Context</span>',
            '<span class="ctx-section-hint">Editable · Custom notes injected into every AI response</span>',
          '</div>',
          '<div class="ctx-section-body" id="ctx-my">',
            '<div class="ctx-editable-wrap">',
              '<p class="ctx-editable-desc">Add anything the AI should always know about the org or project — team decisions, what\'s on hold, who\'s away, current priorities.</p>',
              '<textarea class="ctx-textarea" id="ctx-custom-textarea" rows="8" placeholder="e.g. Barry is on leave until 14 July. NPS project is paused pending Legal review.">' + esc(custom.content || '') + '</textarea>',
              '<div class="ctx-actions"><button class="btn btn-sm btn-primary" onclick="LIB._saveCustomContext()">Save</button>',
              '<span class="ctx-save-status" id="ctx-custom-status"></span></div>',
            '</div>',
          '</div>',
        '</div>',
        '<div class="ctx-section ctx-section-open">',
          '<div class="ctx-section-header" role="button" tabindex="0" onclick="LIB._ctxToggle(\'ctx-personal\')">',
            '<span class="ctx-caret open" id="ctx-personal-caret">▼</span>',
            '<span class="ctx-section-title">Personal Context</span>',
            '<span class="ctx-section-hint">Editable · About you — shapes how the AI speaks to you</span>',
          '</div>',
          '<div class="ctx-section-body" id="ctx-personal">',
            '<div class="ctx-editable-wrap">',
              '<p class="ctx-editable-desc">Tell the AI who you are. This is injected into insights, task guidance, and chat.</p>',
              '<div class="ctx-fields">',
                '<div class="ctx-field"><label>Your name</label><input class="ctx-input" id="ctx-p-name" value="' + esc(personal.name || '') + '" placeholder="e.g. Pedro Moreira"></div>',
                '<div class="ctx-field"><label>Role &amp; seniority</label><input class="ctx-input" id="ctx-p-role" value="' + esc(personal.role || '') + '" placeholder="e.g. Digital Transformation Engineer"></div>',
                '<div class="ctx-field"><label>Skills &amp; tools</label><input class="ctx-input" id="ctx-p-skills" value="' + esc(personal.skills || '') + '" placeholder="e.g. Power Automate, Copilot Studio, SQL Server"></div>',
                '<div class="ctx-field"><label>Current focus</label><input class="ctx-input" id="ctx-p-focus" value="' + esc(personal.focus || '') + '" placeholder="e.g. Bot migration to Copilot Studio v2"></div>',
                '<div class="ctx-field ctx-field-full"><label>Personal notes</label>',
                  '<textarea class="ctx-textarea ctx-textarea-sm" id="ctx-p-notes" rows="4" placeholder="e.g. I prefer direct, actionable answers.">' + esc(personal.notes || '') + '</textarea></div>',
              '</div>',
              '<div class="ctx-actions"><button class="btn btn-sm btn-primary" onclick="LIB._savePersonalContext()">Save</button>',
              '<span class="ctx-save-status" id="ctx-personal-status"></span></div>',
            '</div>',
          '</div>',
        '</div>',
      ].join('');
    },

    _ctxToggle: function (id) {
      var b = document.getElementById(id);
      var c = document.getElementById(id + '-caret');
      if (!b) return;
      var open = b.style.display !== 'none';
      b.style.display = open ? 'none' : '';
      if (c) { c.textContent = open ? '▶' : '▼'; c.classList.toggle('open', !open); }
    },

    _saveCustomContext: async function () {
      var content = (document.getElementById('ctx-custom-textarea') || {}).value || '';
      var statusEl = document.getElementById('ctx-custom-status');
      try {
        await fetch('/pac/context/custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
        if (statusEl) { statusEl.textContent = '✓ Saved'; statusEl.style.color = 'var(--green-text)'; setTimeout(function () { statusEl.textContent = ''; }, 2500); }
        logLine('My Context saved — will be included in all AI responses', 'ok');
      } catch (e) {
        if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.style.color = 'var(--red-text)'; }
        logLine('My Context save failed: ' + e.message, 'err');
      }
    },

    _savePersonalContext: async function () {
      var data = {
        name:   (document.getElementById('ctx-p-name')   || {}).value || '',
        role:   (document.getElementById('ctx-p-role')   || {}).value || '',
        skills: (document.getElementById('ctx-p-skills') || {}).value || '',
        focus:  (document.getElementById('ctx-p-focus')  || {}).value || '',
        notes:  (document.getElementById('ctx-p-notes')  || {}).value || '',
      };
      var statusEl = document.getElementById('ctx-personal-status');
      try {
        await fetch('/pac/context/personal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (statusEl) { statusEl.textContent = '✓ Saved'; statusEl.style.color = 'var(--green-text)'; setTimeout(function () { statusEl.textContent = ''; }, 2500); }
        logLine('Personal Context saved — AI will now use your profile in all responses', 'ok');
      } catch (e) {
        if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.style.color = 'var(--red-text)'; }
        logLine('Personal Context save failed: ' + e.message, 'err');
      }
    },

    // ── Build from local exported solutions ───────────────────────────────────
    buildLocal: async function () {
      var btn = document.getElementById('lib-build-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = icon('hammer') + 'Building…'; }
      var statusEl = document.getElementById('lib-status');
      if (statusEl) statusEl.textContent = 'Scanning local flows…';
      var body = document.getElementById('lib-body');
      if (body) body.innerHTML = '<div class="lib-empty">Scanning local solutions for ApiConnection actions…</div>';
      logLine('Building library from local exported solutions…', 'info');

      try {
        var r = await fetch('/pac/build-library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        var data = await r.json();
        if (data.ok && data.lib) {
          _lib = data.lib;
          var connCount = Object.keys(_lib.connectors || {}).length;
          var opCount = Object.values(_lib.connectors || {}).reduce(function (s, c) { return s + Object.keys(c.operations || {}).length; }, 0);
          var trigCount = Object.keys(_lib.triggers || {}).length;
          var flowCount = Object.keys(_lib.flows || {}).length;
          var mergeNote = data.mergedFrom ? ' — merged into ' + data.mergedFrom + ' base' : '';
          logLine('Library built from local flows' + mergeNote + ': '
            + connCount + ' connectors, ' + opCount + ' operations, '
            + trigCount + ' trigger types, ' + flowCount + ' flows indexed', 'ok');
          if (data.mergedFrom) {
            logLine('Ready to push — click ☁ Push to SharePoint to share improvements with the team', 'info');
          }
          updateStatus();
          _renderActionsView();
        } else {
          var errMsg = data.error || 'unknown error';
          logLine('Library build failed: ' + errMsg, 'err');
          if (statusEl) statusEl.textContent = 'Build failed';
          if (body) body.innerHTML = '<div class="lib-empty lib-error">Build failed: ' + esc(errMsg) + '</div>';
        }
      } catch (e) {
        logLine('Library build error: ' + e.message, 'err');
        if (statusEl) statusEl.textContent = 'Build error';
        if (body) body.innerHTML = '<div class="lib-empty lib-error">Error: ' + esc(e.message) + '</div>';
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = icon('hammer') + 'Build from local flows'; }
      }
    },
  };

})();
