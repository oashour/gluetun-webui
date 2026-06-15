/* Gluetun Web UI - app.js */

const MAX_HISTORY = 30;
const VALID_STATES = new Set(['connected', 'paused', 'disconnected', 'unknown']);

let instances    = [];   // [{ id, name }] from /api/instances
let isPolling    = false;
let refreshTimer = null;
const serverDataCache     = new Map(); // instanceId -> server data from /api/:id/servers
const serverSelectorReady = new Set(); // guard: pre-populate only once per instance
const serverLastSelCache  = new Map(); // instanceId -> latest server_selection from gluetun

// ---- Utility ----

function $(id) { return document.getElementById(id); }
function setText(id, val) { const el = $(id); if (el) el.textContent = val ?? '–'; }
function setEl(id, val)   { const el = document.getElementById(id); if (el) el.textContent = val ?? '–'; }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info', duration = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, duration);
}

// ---- Per-instance session history ----

function sessionKey(id) { return `gluetun_history_${id}`; }

function loadHistoryFor(id) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sessionKey(id)));
    return Array.isArray(raw) ? raw.filter(s => VALID_STATES.has(s)) : [];
  } catch (_) { return []; }
}

function pushHistoryFor(id, state) {
  const hist = loadHistoryFor(id);
  hist.push(state);
  if (hist.length > MAX_HISTORY) hist.shift();
  try { sessionStorage.setItem(sessionKey(id), JSON.stringify(hist)); } catch (_) {}
}

function renderHistoryFor(id) {
  const track = document.getElementById(`i${id}-history-track`);
  if (!track) return;
  const hist = loadHistoryFor(id);
  track.innerHTML = '';
  hist.forEach((s, i) => {
    const tick = document.createElement('div');
    tick.className = `history-tick ${s}`;
    tick.title = `Poll #${i + 1}: ${s}`;
    track.appendChild(tick);
  });
}

// ---- Dashboard group builder (old layout per instance) ----

function buildDashboardGroup(inst) {
  const id = inst.id;
  const group = document.createElement('div');
  group.className = 'dashboard-group';
  group.id = `dashboard-${id}`;
  group.innerHTML = `
    <!-- Status banner -->
    <div class="status-banner unknown" id="i${id}-banner">
      <div class="banner-icon">&#9679;</div>
      <div class="banner-text">
        <span id="i${id}-banner-title">Checking VPN status…</span>
        <span id="i${id}-banner-sub" class="muted"></span>
      </div>
      <div class="banner-actions">
        <button id="i${id}-btn-start" class="btn-success">&#9654; Start</button>
        <button id="i${id}-btn-stop" class="btn-danger">&#9209; Stop</button>
      </div>
    </div>

    <div class="dashboard-grid">
      <!-- Public IP card -->
      <div class="card">
        <div class="card-header">
          <span class="card-icon">&#127760;</span>
          <h3>${escHtml(inst.name)}</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Public IP</span><span class="stat-value mono" id="i${id}-ip-address">–</span></div>
          <div class="stat-row"><span class="stat-label">Country</span><span class="stat-value" id="i${id}-ip-country">–</span></div>
          <div class="stat-row"><span class="stat-label">City</span><span class="stat-value" id="i${id}-ip-city">–</span></div>
          <div class="stat-row"><span class="stat-label">Organisation</span><span class="stat-value" id="i${id}-ip-org">–</span></div>
        </div>
      </div>

      <!-- VPN details card -->
      <div class="card">
        <div class="card-header">
          <span class="card-icon">&#128274;</span>
          <h3>VPN Connection</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="i${id}-vpn-status">–</span></div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value" id="i${id}-vpn-provider">–</span></div>
          <div class="stat-row"><span class="stat-label">Server</span><span class="stat-value mono" id="i${id}-vpn-server">–</span></div>
          <div class="stat-row"><span class="stat-label">Protocol</span><span class="stat-value" id="i${id}-vpn-protocol">–</span></div>
          <div class="stat-row"><span class="stat-label">Country</span><span class="stat-value" id="i${id}-vpn-country">–</span></div>
          <div class="stat-row"><span class="stat-label">City</span><span class="stat-value" id="i${id}-vpn-city">–</span></div>
        </div>
      </div>

      <!-- Port forwarding card -->
      <div class="card">
        <div class="card-header">
          <span class="card-icon">&#128268;</span>
          <h3>Port Forwarding</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Forwarded Port</span><span class="stat-value mono" id="i${id}-port-number">–</span></div>
        </div>
      </div>

      <!-- DNS card -->
      <div class="card">
        <div class="card-header">
          <span class="card-icon">&#128225;</span>
          <h3>DNS</h3>
        </div>
        <div class="card-body">
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="i${id}-dns-status">–</span></div>
        </div>
      </div>

      <!-- Server Selector card -->
      <div class="card">
        <div class="card-header">
          <span class="card-icon">&#128205;</span>
          <h3>Server Selector</h3>
        </div>
        <div class="card-body">
          <div class="filter-bar" id="i${id}-filter-bar" style="display:none">
            <div class="filter-bar-row">
              <span class="filter-bar-label">&#8801; Filters</span>
              <div class="filter-chips-row" id="i${id}-bool-chips"></div>
              <button class="sel-clear-btn" id="i${id}-filters-clear" title="Clear all filters" tabindex="-1">&#10005;</button>
            </div>
            <div class="filter-isp-panel" id="i${id}-isp-section" style="display:none">
              <div class="filter-isp-inner">
                <select multiple size="3" id="i${id}-sel-isp" class="server-select" disabled></select>
              </div>
              <button class="sel-clear-btn" id="i${id}-isp-clear" title="Clear ISP" tabindex="-1">&#10005;</button>
            </div>
          </div>
          <div class="stat-row">
            <span class="stat-label">Provider</span>
            ${inst.providers?.length
              ? `<select id="i${id}-sel-provider" class="provider-select"></select>`
              : `<span class="stat-value" id="i${id}-sel-provider">–</span>`}
          </div>
          <div id="i${id}-geo-panels"></div>
          <div class="server-selector-footer">
            <small class="sel-hint">Nothing selected = Any</small>
            <div class="sel-footer-actions">
              <button id="i${id}-sel-reset" class="btn-reset" disabled>Reset</button>
              <button id="i${id}-sel-apply" class="btn-apply" disabled>Apply</button>
            </div>
          </div>
        </div>
      </div>

      <!-- History card -->
      <div class="card card-wide">
        <div class="card-header">
          <span class="card-icon">&#128200;</span>
          <h3>Status History (last 30 polls)</h3>
        </div>
        <div class="card-body">
          <div class="history-track" id="i${id}-history-track"></div>
          <div class="history-legend">
            <span class="dot connected"></span> Connected &nbsp;
            <span class="dot paused"></span> Paused &nbsp;
            <span class="dot disconnected"></span> Disconnected &nbsp;
            <span class="dot unknown"></span> Unknown
          </div>
        </div>
      </div>
    </div>
  `;
  group.querySelector(`#i${id}-btn-start`).addEventListener('click', () => vpnAction(id, 'start'));
  group.querySelector(`#i${id}-btn-stop`).addEventListener('click', () => vpnAction(id, 'stop'));
  group.querySelector(`#i${id}-sel-apply`).addEventListener('click', () => applyServerSelection(id));
  group.querySelector(`#i${id}-sel-reset`).addEventListener('click', () => resetServerSelector(id));
  if (inst.providers?.length) {
    const provSel = group.querySelector(`#i${id}-sel-provider`);
    inst.providers.forEach(p => provSel.appendChild(new Option(p.label, String(p.index))));
    provSel.addEventListener('change', () => onProviderChange(id));
  }
  group.querySelector(`#i${id}-sel-isp`).addEventListener('change', () => onBooleanChange(id));
  group.querySelector(`#i${id}-isp-clear`).addEventListener('click', e => {
    e.stopPropagation();
    clearLevel(id, 'isp');
  });
  group.querySelector(`#i${id}-filters-clear`).addEventListener('click', e => {
    e.stopPropagation();
    clearFilters(id);
  });
  return group;
}

function renderAllDashboards() {
  const container = $('dashboards-container');
  container.innerHTML = '';
  instances.forEach(inst => {
    container.appendChild(buildDashboardGroup(inst));
    renderHistoryFor(inst.id);
  });
  // Set grid columns: 1=full, 2=half, 3=third, 4=quarter
  const cols = Math.min(instances.length, 4) || 1;
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// ---- Update a panel with health data ----

function updatePanel(inst, health) {
  const id = inst.id;
  const { vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings } = health;

  const d  = vpnStatus?.ok   ? vpnStatus.data   : null;
  const s  = vpnSettings?.ok ? vpnSettings.data  : null;
  const ip = publicIp?.ok    ? publicIp.data     : null;

  const running = d?.status === 'running';
  const stopped = d?.status === 'stopped';
  const state = !vpnStatus?.ok ? 'unknown'
    : running ? 'connected'
    : stopped ? 'paused'
    : 'disconnected';

  const banner = document.getElementById(`i${id}-banner`);
  if (banner) banner.className = `status-banner ${state}`;

  const pubIpStr = ip?.public_ip ?? ip?.ip ?? '';
  let sub = '';
  if      (state === 'connected')    sub = pubIpStr ? `Public IP: ${pubIpStr}` : 'Tunnel is up';
  else if (state === 'paused')       sub = pubIpStr ? `Gluetun active – exit IP: ${pubIpStr}` : 'Gluetun active – VPN process stopped';
  else if (state === 'disconnected') sub = 'Tunnel is down – traffic may be unprotected';
  else                               sub = 'Could not reach Gluetun control API';
  
  const title = state === 'connected' ? 'VPN Connected' 
    : state === 'paused' ? 'VPN Paused'
    : state === 'disconnected' ? 'VPN Disconnected'
    : 'Status Unknown';
  setEl(`i${id}-banner-title`, title);
  setEl(`i${id}-banner-sub`, sub);

  setEl(`i${id}-ip-address`, ip?.public_ip ?? ip?.ip ?? ip?.IP ?? '–');
  setEl(`i${id}-ip-country`, ip?.country ?? '–');
  setEl(`i${id}-ip-city`, ip?.city ?? '–');
  setEl(`i${id}-ip-org`, ip?.org ?? ip?.organization ?? '–');

  setEl(`i${id}-vpn-status`,   d?.status ?? '–');
  setEl(`i${id}-vpn-provider`, s?.provider?.name ?? '–');
  if (s?.provider?.name) {
    // Sync provider: on first load (before selector is ready) snap dropdown to active provider.
    // After that, leave the dropdown alone so user changes aren't clobbered by polling.
    const provSel = $(`i${id}-sel-provider`);
    if (provSel?.tagName === 'SELECT') {
      if (!serverSelectorReady.has(id)) {
        const activeInst = instances.find(i => i.id === id);
        const match = activeInst?.providers?.find(p => p.providerName === s.provider.name);
        if (match) provSel.value = String(match.index);
      }
    } else if (provSel) {
      provSel.textContent = s.provider.name;
    }
    // Store server_selection + active provider name for Reset
    serverLastSelCache.set(id, {
      ...(s.provider.server_selection ?? {}),
      _activeProviderName: s.provider.name,
    });
    loadServerData(id, s.provider.server_selection ?? {});
  }
  setEl(`i${id}-vpn-protocol`, s?.type ?? '–');
  setEl(`i${id}-vpn-server`,
    ip?.hostname
    ?? s?.provider?.server_selection?.hostnames?.[0]
    ?? s?.provider?.server_selection?.names?.[0]
    ?? '–');
  setEl(`i${id}-vpn-country`, ip?.country ?? '–');
  setEl(`i${id}-vpn-city`, ip?.city ?? '–');

  const port = portForwarded?.ok ? (portForwarded.data?.port ?? 0) : 0;
  setEl(`i${id}-port-number`, port > 0 ? String(port) : portForwarded?.ok ? 'Not forwarded' : 'N/A');

  setEl(`i${id}-dns-status`, dnsStatus?.ok ? (dnsStatus.data?.status ?? 'OK') : 'Unavailable');

  pushHistoryFor(id, state);
  renderHistoryFor(id);
}

function updatePanelError(inst) {
  const id = inst.id;
  const banner = document.getElementById(`i${id}-banner`);
  if (banner) banner.className = 'status-banner unknown';
  setEl(`i${id}-banner-title`, 'Status Unknown');
  setEl(`i${id}-banner-sub`, 'Could not reach Gluetun control API');
  setEl(`i${id}-ip-address`, '–');
  setEl(`i${id}-ip-country`, '–');
  setEl(`i${id}-ip-city`, '–');
  setEl(`i${id}-ip-org`, '–');
  setEl(`i${id}-vpn-status`, '–');
  setEl(`i${id}-vpn-provider`, '–');
  setEl(`i${id}-vpn-server`, '–');
  setEl(`i${id}-vpn-protocol`, '–');
  setEl(`i${id}-vpn-country`, '–');
  setEl(`i${id}-vpn-city`, '–');
  setEl(`i${id}-port-number`, 'N/A');
  setEl(`i${id}-dns-status`, 'Unavailable');
  pushHistoryFor(id, 'unknown');
  renderHistoryFor(id);
}

// ---- API ----

async function fetchHealth(instanceId) {
  const res = await fetch(`/api/${instanceId}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Poll all instances in parallel ----

async function pollAll() {
  if (isPolling) return;
  isPolling = true;
  const refreshBtn = $('refresh-btn');
  refreshBtn.innerHTML = '<span class="spin">&#x21bb;</span> Refresh';
  refreshBtn.disabled = true;

  await Promise.allSettled(instances.map(async inst => {
    try {
      const health = await fetchHealth(inst.id);
      updatePanel(inst, health);
    } catch (_) {
      updatePanelError(inst);
    }
  }));

  setText('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  refreshBtn.innerHTML = '&#x21bb; Refresh';
  refreshBtn.disabled = false;
  isPolling = false;
}

// ---- VPN actions ----

async function vpnAction(instanceId, action) {
  const inst  = instances.find(i => i.id === instanceId);
  const name  = inst?.name ?? instanceId;
  const label = action === 'start' ? 'Starting' : 'Stopping';
  showToast(`${label} ${name}…`, 'info', 5000);
  try {
    const res  = await fetch(`/api/${instanceId}/vpn/${action}`, { method: 'PUT' });
    const data = await res.json();
    if (data.ok) {
      showToast(`${name}: VPN ${action} command sent`, 'success');
      setTimeout(async () => { await pollAll(); scheduleNextPoll(); }, 2000);
    } else {
      showToast(`${name}: ${data.error ?? 'Unknown error'}`, 'error', 5000);
    }
  } catch (err) {
    showToast(`${name}: Request failed: ${err.message}`, 'error', 5000);
  }
}

// ---- Server selector ----

function updateSelSummary(instanceId, level) {
  const el      = $(`i${instanceId}-sel-${level}`);
  const summary = $(`i${instanceId}-sel-${level}-summary`);
  if (!el || !summary) return;
  const selected = [...el.selectedOptions].map(o => o.value);
  summary.textContent = selected.length ? selected.join(', ') : 'Any';
  summary.classList.toggle('sel-summary-any', !selected.length);
}

function updateCount(instanceId, level) {
  const selectEl = $(`i${instanceId}-sel-${level}`);
  const countEl  = $(`i${instanceId}-${level}-count`);
  if (!countEl || !selectEl) return;
  const count = [...selectEl.options].filter(o => !o.disabled).length;
  countEl.textContent = count > 0 ? String(count) : '';
}

function getCheckedBooleans(instanceId, data) {
  return (data?.booleanFilters ?? [])
    .filter(({ key }) => $(`i${instanceId}-bool-${key}`)?.dataset.active === 'true')
    .map(({ key }) => key);
}

// ---- Generic geo tree helpers ----

function navigatePath(tree, path) {
  let node = tree;
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = node[key];
  }
  return node;
}

function collectLeafHostnames(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  const out = [];
  for (const child of Object.values(node)) out.push(...collectLeafHostnames(child));
  return out;
}

function subtreeHasViable(data, geoTree, path, filters) {
  if (!filters.checkedBools.length && !filters.selectedIsps.length) return true;
  return collectLeafHostnames(navigatePath(geoTree, path)).some(h => hostnameMatchesFilters(data, h, filters));
}

function getEffectivePaths(instanceId, data, upToLevel) {
  const { geoTree } = data;
  const filters = getFilters(instanceId, data);
  let paths = [[]];
  for (let i = 0; i <= upToLevel; i++) {
    const el = $(`i${instanceId}-sel-${i}`);
    const selected = el ? new Set([...el.selectedOptions].map(o => o.value)) : new Set();
    const next = [];
    for (const path of paths) {
      const node = navigatePath(geoTree, path);
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      for (const key of Object.keys(node)) {
        if (selected.size && !selected.has(key)) continue;
        const childPath = [...path, key];
        if (subtreeHasViable(data, geoTree, childPath, filters)) next.push(childPath);
      }
    }
    paths = next;
  }
  return paths;
}

function buildGeoPanel(instanceId, levelIdx) {
  const data = serverDataCache.get(instanceId);
  if (!data) return;
  const { geoTree } = data;
  const filters = getFilters(instanceId, data);
  const el = $(`i${instanceId}-sel-${levelIdx}`);
  if (!el) return;

  const prevSelected = new Set([...el.selectedOptions].map(o => o.value));
  el.innerHTML = '';

  const parentPaths = getEffectivePaths(instanceId, data, levelIdx - 1);
  parentPaths.forEach(parentPath => {
    const parentNode = navigatePath(geoTree, parentPath);
    if (!parentNode || typeof parentNode !== 'object' || Array.isArray(parentNode)) return;

    const viableKeys = Object.keys(parentNode)
      .filter(k => subtreeHasViable(data, geoTree, [...parentPath, k], filters));
    if (!viableKeys.length) return;

    if (parentPath.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = parentPath[parentPath.length - 1];
      viableKeys.forEach(k => {
        const opt = new Option(k, k);
        opt.selected = prevSelected.has(k);
        grp.appendChild(opt);
      });
      el.appendChild(grp);
    } else {
      viableKeys.forEach(k => {
        const opt = new Option(k, k);
        opt.selected = prevSelected.has(k);
        el.appendChild(opt);
      });
    }
  });

  updateSelSummary(instanceId, String(levelIdx));
  updateCount(instanceId, String(levelIdx));
}

function buildHostnamePanel(instanceId) {
  const data = serverDataCache.get(instanceId);
  if (!data) return;
  const { geoTree, geoLevels } = data;
  const filters = getFilters(instanceId, data);
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  if (!hostnameEl) return;

  const prevSelected = new Set([...hostnameEl.selectedOptions].map(o => o.value));
  hostnameEl.innerHTML = '';

  const leafPaths = getEffectivePaths(instanceId, data, geoLevels.length - 1);
  leafPaths.forEach(leafPath => {
    const hostnames = navigatePath(geoTree, leafPath);
    if (!Array.isArray(hostnames)) return;
    const filtered = (filters.checkedBools.length || filters.selectedIsps.length)
      ? hostnames.filter(h => hostnameMatchesFilters(data, h, filters))
      : hostnames;
    if (!filtered.length) return;
    const grp = document.createElement('optgroup');
    const lastVal   = leafPath[leafPath.length - 1];
    const parentVal = leafPath.length >= 2 ? leafPath[leafPath.length - 2] : null;
    grp.label = parentVal ? `${lastVal}, ${parentVal}` : lastVal;
    filtered.forEach(h => {
      const opt = new Option(data.hostnameLabels?.[h] ?? h, h);
      opt.selected = prevSelected.has(h);
      grp.appendChild(opt);
    });
    hostnameEl.appendChild(grp);
  });

  updateSelSummary(instanceId, 'hostname');
  updateCount(instanceId, 'hostname');
}

function onGeoChange(instanceId, levelIdx) {
  const data = serverDataCache.get(instanceId);
  if (!data) return;
  updateSelSummary(instanceId, String(levelIdx));
  for (let i = levelIdx + 1; i < data.geoLevels.length; i++) buildGeoPanel(instanceId, i);
  buildHostnamePanel(instanceId);
}

function onProviderChange(instanceId) {
  serverSelectorReady.delete(instanceId);
  serverDataCache.delete(instanceId);
  loadServerData(instanceId, {});
}

function buildHostnamePathMap(geoTree) {
  const map = {};
  function traverse(node, path) {
    if (Array.isArray(node)) { node.forEach(h => { map[h] = path; }); }
    else if (node && typeof node === 'object') {
      for (const [k, child] of Object.entries(node)) traverse(child, [...path, k]);
    }
  }
  traverse(geoTree, []);
  return map;
}

function pluralField(f) {
  return f.endsWith('y') ? f.slice(0, -1) + 'ies' : f + 's';
}

function resolveSelection(data, rawSel) {
  const { geoLevels, geoTree } = data;
  const hostnames = (rawSel.hostnames ?? []).filter(Boolean);

  const levelSels = geoLevels.map(({ field }) =>
    (rawSel[pluralField(field)] ?? []).filter(Boolean)
  );

  // If only hostnames given: reverse-lookup paths from tree
  if (hostnames.length && levelSels.every(s => !s.length)) {
    const pathMap = buildHostnamePathMap(geoTree);
    geoLevels.forEach((_, i) => {
      levelSels[i] = [...new Set(hostnames.map(h => pathMap[h]?.[i]).filter(Boolean))].sort();
    });
  } else {
    // Forward-fill missing ancestors from known descendants
    for (let i = geoLevels.length - 1; i > 0; i--) {
      if (levelSels[i].length && !levelSels[i - 1].length) {
        const parents = new Set();
        (function findParents(node, path, depth) {
          if (Array.isArray(node) || !node) return;
          if (depth === i) {
            for (const k of Object.keys(node)) {
              if (levelSels[i].includes(k)) parents.add(path[i - 1]);
            }
          } else {
            for (const [k, child] of Object.entries(node)) findParents(child, [...path, k], depth + 1);
          }
        })(geoTree, [], 0);
        levelSels[i - 1] = [...parents].sort();
      }
    }
  }

  // Case-normalize each level's selections against actual tree values
  const allValsAtLevel = (depth) => {
    const vals = new Set();
    (function traverse(node, d) {
      if (d === depth) { if (!Array.isArray(node) && node) Object.keys(node).forEach(k => vals.add(k)); }
      else if (!Array.isArray(node) && node) Object.values(node).forEach(c => traverse(c, d + 1));
    })(geoTree, 0);
    return vals;
  };
  const normalized = levelSels.map((sels, i) => {
    const lookup = Object.fromEntries([...allValsAtLevel(i)].map(v => [v.toLowerCase(), v]));
    return sels.map(v => lookup[v.trim().toLowerCase()]).filter(Boolean);
  });

  return { levelSels: normalized, hostnames };
}

function openAccordion(instanceId, level) {
  $(`i${instanceId}-acc-${level}`)?.classList.add('open');
}

function toggleAccordion(instanceId, level) {
  $(`i${instanceId}-acc-${level}`)?.classList.toggle('open');
}

function clearLevel(instanceId, level) {
  if (level === 'isp') {
    const el = $(`i${instanceId}-sel-isp`);
    if (el) [...el.options].forEach(o => o.selected = false);
    onBooleanChange(instanceId);
  } else if (level === 'hostname') {
    const el = $(`i${instanceId}-sel-hostname`);
    if (el) [...el.options].forEach(o => o.selected = false);
    updateSelSummary(instanceId, 'hostname');
    updateCount(instanceId, 'hostname');
  } else {
    // Numeric geo level index
    const idx = Number(level);
    const el = $(`i${instanceId}-sel-${idx}`);
    if (el) [...el.options].forEach(o => o.selected = false);
    onGeoChange(instanceId, idx);
  }
}

function resetServerSelector(instanceId) {
  const lastSel = serverLastSelCache.get(instanceId) ?? {};
  let data = serverDataCache.get(instanceId);

  // Restore provider dropdown (if applicable) and reload servers if provider changed
  const inst = instances.find(i => i.id === instanceId);
  const provSel = $(`i${instanceId}-sel-provider`);
  if (provSel?.tagName === 'SELECT' && lastSel._activeProviderName) {
    const match = inst?.providers?.find(p => p.providerName === lastSel._activeProviderName);
    if (match) {
      const prevIdx = Number(provSel.value);
      provSel.value = String(match.index);
      if (prevIdx !== match.index) {
        serverSelectorReady.delete(instanceId);
        serverDataCache.delete(instanceId);
        data = null; // force reload
      }
    }
  }

  if (!data) {
    // Provider changed — reload server data with the reset provider then repopulate
    loadServerData(instanceId, lastSel);
    return;
  }

  (data.booleanFilters ?? []).forEach(({ key }) => {
    const chip = $(`i${instanceId}-bool-${key}`);
    if (chip) { chip.dataset.active = 'false'; chip.classList.remove('filter-chip-on'); }
  });
  const ispEl = $(`i${instanceId}-sel-isp`);
  if (ispEl) [...ispEl.options].forEach(o => o.selected = false);
  populateServerSelector(instanceId, data, lastSel);
}

function getSelectedIsps(instanceId) {
  const el = $(`i${instanceId}-sel-isp`);
  return el ? [...el.selectedOptions].map(o => o.value) : [];
}

function getFilters(instanceId, data) {
  return {
    checkedBools: getCheckedBooleans(instanceId, data),
    selectedIsps: getSelectedIsps(instanceId),
  };
}

function hostnameMatchesFilters(data, hostname, filters) {
  if (filters.checkedBools.some(key => !data.hostnameFlags?.[hostname]?.includes(key))) return false;
  if (filters.selectedIsps.length) {
    const isp = data.hostnameIsps?.[hostname];
    if (!isp || !filters.selectedIsps.includes(isp)) return false;
  }
  return true;
}

function updateIspChip(instanceId) {
  const chip = $(`i${instanceId}-bool-isp`);
  if (!chip) return;
  const selected = getSelectedIsps(instanceId);
  const on = selected.length > 0;
  chip.dataset.active = String(on);
  chip.classList.toggle('filter-chip-on', on);
  chip.textContent = on ? `ISP (${selected.length})` : 'ISP';
}

function clearFilters(instanceId) {
  const data = serverDataCache.get(instanceId);
  (data?.booleanFilters ?? []).forEach(({ key }) => {
    const chip = $(`i${instanceId}-bool-${key}`);
    if (chip) { chip.dataset.active = 'false'; chip.classList.remove('filter-chip-on'); }
  });
  const ispEl = $(`i${instanceId}-sel-isp`);
  if (ispEl) [...ispEl.options].forEach(o => o.selected = false);
  const ispSection = $(`i${instanceId}-isp-section`);
  if (ispSection) ispSection.style.display = 'none';
  const ispChip = $(`i${instanceId}-bool-isp`);
  if (ispChip) { ispChip.dataset.active = 'false'; ispChip.classList.remove('filter-chip-on'); ispChip.textContent = 'ISP'; }
  onBooleanChange(instanceId);
}

function onBooleanChange(instanceId) {
  const data = serverDataCache.get(instanceId);
  if (!data) return;
  updateIspChip(instanceId);
  buildGeoPanel(instanceId, 0);
  onGeoChange(instanceId, 0);
}

function populateServerSelector(instanceId, data, currentSel = {}) {
  const geoPanels = $(`i${instanceId}-geo-panels`);
  if (!geoPanels) return;

  // Build dynamic geo accordion panels
  geoPanels.innerHTML = '';
  data.geoLevels.forEach(({ label }, idx) => {
    const item = document.createElement('div');
    item.className = 'sel-acc-item';
    item.id = `i${instanceId}-acc-${idx}`;
    item.innerHTML = `
      <div class="sel-acc-header">
        <span class="sel-acc-label">${escHtml(label)}</span>
        <span class="sel-count" id="i${instanceId}-${idx}-count"></span>
        <span class="sel-summary sel-summary-any" id="i${instanceId}-sel-${idx}-summary">Any</span>
        <button class="sel-clear-btn" title="Clear" tabindex="-1">&#10005;</button>
        <span class="sel-acc-arrow">&#9660;</span>
      </div>
      <div class="sel-acc-body">
        <select multiple size="7" id="i${instanceId}-sel-${idx}" class="server-select"></select>
      </div>`;
    item.querySelector('.sel-acc-header').addEventListener('click', e => {
      if (!e.target.closest('.sel-clear-btn')) toggleAccordion(instanceId, String(idx));
    });
    item.querySelector('.sel-clear-btn').addEventListener('click', e => {
      e.stopPropagation();
      clearLevel(instanceId, String(idx));
    });
    item.querySelector('select').addEventListener('change', () => onGeoChange(instanceId, idx));
    geoPanels.appendChild(item);
  });

  // Add hostname accordion
  const hostnameItem = document.createElement('div');
  hostnameItem.className = 'sel-acc-item';
  hostnameItem.id = `i${instanceId}-acc-hostname`;
  hostnameItem.innerHTML = `
    <div class="sel-acc-header">
      <span class="sel-acc-label">Server</span>
      <span class="sel-count" id="i${instanceId}-hostname-count"></span>
      <span class="sel-summary sel-summary-any" id="i${instanceId}-sel-hostname-summary">Any</span>
      <button class="sel-clear-btn" title="Clear" tabindex="-1">&#10005;</button>
      <span class="sel-acc-arrow">&#9660;</span>
    </div>
    <div class="sel-acc-body">
      <select multiple size="7" id="i${instanceId}-sel-hostname" class="server-select"></select>
    </div>`;
  hostnameItem.querySelector('.sel-acc-header').addEventListener('click', e => {
    if (!e.target.closest('.sel-clear-btn')) toggleAccordion(instanceId, 'hostname');
  });
  hostnameItem.querySelector('.sel-clear-btn').addEventListener('click', e => {
    e.stopPropagation();
    clearLevel(instanceId, 'hostname');
  });
  hostnameItem.querySelector('select').addEventListener('change', () => updateSelSummary(instanceId, 'hostname'));
  geoPanels.appendChild(hostnameItem);

  const providerEl = $(`i${instanceId}-sel-provider`);
  if (providerEl && providerEl.tagName !== 'SELECT') providerEl.textContent = data.provider ?? '–';

  // Resolve pre-selection from current gluetun settings
  const { levelSels, hostnames } = resolveSelection(data, currentSel);

  // Build geo level 0, then pre-select
  buildGeoPanel(instanceId, 0);
  const el0 = $(`i${instanceId}-sel-0`);
  if (el0 && levelSels[0]?.length) {
    [...el0.options].forEach(o => { o.selected = levelSels[0].includes(o.value); });
    updateSelSummary(instanceId, '0');
  }

  // Build levels 1..N-1 with parent context applied, pre-select each
  for (let i = 1; i < data.geoLevels.length; i++) {
    buildGeoPanel(instanceId, i);
    const elI = $(`i${instanceId}-sel-${i}`);
    if (elI && levelSels[i]?.length) {
      [...elI.options].forEach(o => { o.selected = levelSels[i].includes(o.value); });
      updateSelSummary(instanceId, String(i));
    }
  }

  // Build hostname panel, pre-select
  buildHostnamePanel(instanceId);
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  if (hostnameEl && hostnames.length) {
    [...hostnameEl.options].forEach(o => { o.selected = hostnames.includes(o.value); });
    updateSelSummary(instanceId, 'hostname');
  }

  const applyBtn = $(`i${instanceId}-sel-apply`);
  if (applyBtn) applyBtn.disabled = false;
  const resetBtn = $(`i${instanceId}-sel-reset`);
  if (resetBtn) resetBtn.disabled = false;

  // ISP multi-select (inside filter bar)
  const ispSection = $(`i${instanceId}-isp-section`);
  const ispEl      = $(`i${instanceId}-sel-isp`);
  if (ispSection) ispSection.style.display = 'none';
  if (ispSection && ispEl && data.isps?.length) {
    ispEl.innerHTML = '';
    data.isps.forEach(isp => ispEl.appendChild(new Option(isp, isp)));
    ispEl.disabled = false;
  }

  // Boolean filter chips
  const chipsRow  = $(`i${instanceId}-bool-chips`);
  const filterBar = $(`i${instanceId}-filter-bar`);
  const hasFilters = (data.booleanFilters?.length || data.isps?.length);
  if (chipsRow) {
    chipsRow.innerHTML = '';
    (data.booleanFilters ?? []).forEach(({ key, label }) => {
      const chip = document.createElement('button');
      chip.id = `i${instanceId}-bool-${key}`;
      chip.className = 'filter-chip';
      chip.dataset.active = 'false';
      chip.textContent = label;
      chip.addEventListener('click', () => {
        const on = chip.dataset.active !== 'true';
        chip.dataset.active = String(on);
        chip.classList.toggle('filter-chip-on', on);
        onBooleanChange(instanceId);
      });
      chipsRow.appendChild(chip);
    });
    if (data.isps?.length) {
      const ispChip = document.createElement('button');
      ispChip.id = `i${instanceId}-bool-isp`;
      ispChip.className = 'filter-chip';
      ispChip.dataset.active = 'false';
      ispChip.textContent = 'ISP';
      ispChip.addEventListener('click', () => {
        const panel = $(`i${instanceId}-isp-section`);
        if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });
      chipsRow.appendChild(ispChip);
    }
  }
  if (filterBar) filterBar.style.display = hasFilters ? '' : 'none';

  // All accordions start collapsed
  for (let i = 0; i < data.geoLevels.length; i++) $(`i${instanceId}-acc-${i}`)?.classList.remove('open');
  $(`i${instanceId}-acc-hostname`)?.classList.remove('open');

  serverSelectorReady.add(instanceId);
}

async function loadServerData(instanceId, currentSel) {
  if (serverSelectorReady.has(instanceId)) return;
  if (serverDataCache.has(instanceId)) {
    populateServerSelector(instanceId, serverDataCache.get(instanceId), currentSel);
    return;
  }
  const inst = instances.find(i => i.id === instanceId);
  const provSel = $(`i${instanceId}-sel-provider`);
  const providerIndex = (inst?.providers?.length && provSel?.tagName === 'SELECT')
    ? (Number(provSel.value) || null)
    : null;
  const url = providerIndex != null
    ? `/api/${instanceId}/servers?providerIndex=${providerIndex}`
    : `/api/${instanceId}/servers`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? 'Failed to load server list');
    serverDataCache.set(instanceId, data);
    populateServerSelector(instanceId, data, currentSel);
  } catch (err) {
    const geoPanels = $(`i${instanceId}-geo-panels`);
    if (geoPanels) geoPanels.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;padding:0.4rem 0">Could not load server list</div>';
    console.warn(`[server-selector][${instanceId}]`, err.message);
  }
}

async function applyServerSelection(instanceId) {
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  const applyBtn   = $(`i${instanceId}-sel-apply`);
  const inst       = instances.find(i => i.id === instanceId);
  const name       = inst?.name ?? instanceId;
  const data       = serverDataCache.get(instanceId);

  const hostnames = [...(hostnameEl?.selectedOptions ?? [])].map(o => o.value);
  const geoSels = {};
  (data?.geoLevels ?? []).forEach(({ field }, idx) => {
    const el = $(`i${instanceId}-sel-${idx}`);
    geoSels[pluralField(field)] = el ? [...el.selectedOptions].map(o => o.value) : [];
  });
  const booleans = {};
  (data?.booleanFilters ?? []).forEach(({ key }) => {
    const chip = $(`i${instanceId}-bool-${key}`);
    if (chip) booleans[key] = chip.dataset.active === 'true';
  });
  const provSel = $(`i${instanceId}-sel-provider`);
  const providerIndex = (inst?.providers?.length && provSel?.tagName === 'SELECT')
    ? (Number(provSel.value) || null)
    : null;

  applyBtn.disabled    = true;
  applyBtn.textContent = 'Applying…';
  showToast(`${name}: Applying server selection…`, 'info', 8000);

  try {
    const body = { ...geoSels, hostnames, booleans };
    if (providerIndex != null) body.providerIndex = providerIndex;
    const res = await fetch(`/api/${instanceId}/vpn/settings`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const result = await res.json();
    if (result.ok) {
      showToast(`${name}: Server selection applied`, 'success');
      setTimeout(async () => { await pollAll(); scheduleNextPoll(); }, 3000);
    } else {
      showToast(`${name}: ${result.error ?? 'Unknown error'}`, 'error', 5000);
    }
  } catch (err) {
    showToast(`${name}: Request failed: ${err.message}`, 'error', 5000);
  } finally {
    applyBtn.disabled    = false;
    applyBtn.textContent = 'Apply';
  }
}

// ---- Auto refresh ----

function scheduleNextPoll() {
  clearTimeout(refreshTimer);
  const interval = parseInt($('refresh-interval').value, 10);
  if (interval > 0) {
    refreshTimer = setTimeout(async () => {
      await pollAll();
      scheduleNextPoll();
    }, interval);
  }
}

function applyAutoRefresh() {
  clearTimeout(refreshTimer);
  scheduleNextPoll();
}

// ---- Init ----

$('refresh-btn').addEventListener('click', () => {
  clearTimeout(refreshTimer);
  pollAll().then(() => scheduleNextPoll());
});
$('refresh-interval').addEventListener('change', applyAutoRefresh);

(async () => {
  try {
    const res = await fetch('/api/instances');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    instances = await res.json();
  } catch (_) {
    instances = [{ id: '1', name: 'Gluetun' }];
  }
  renderAllDashboards();
  await pollAll();
  scheduleNextPoll();
})();
