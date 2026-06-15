/* Gluetun Web UI - app.js */

const MAX_HISTORY = 30;
const VALID_STATES = new Set(['connected', 'paused', 'disconnected', 'unknown']);

let instances    = [];   // [{ id, name }] from /api/instances
let isPolling    = false;
let refreshTimer = null;
const serverDataCache    = new Map(); // instanceId -> server data from /api/:id/servers
const serverSelectorReady = new Set(); // guard: pre-populate only once per instance

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
          <div class="stat-row">
            <span class="stat-label">Provider</span>
            <span class="stat-value" id="i${id}-sel-provider">–</span>
          </div>
          <div class="sel-group">
            <div class="sel-group-header">
              <span class="stat-label">Country</span>
              <span class="sel-summary" id="i${id}-sel-country-summary"></span>
            </div>
            <select multiple size="6" id="i${id}-sel-country" class="server-select" disabled></select>
          </div>
          <div class="sel-group">
            <div class="sel-group-header">
              <span class="stat-label">City</span>
              <span class="sel-summary" id="i${id}-sel-city-summary"></span>
            </div>
            <select multiple size="6" id="i${id}-sel-city" class="server-select" disabled></select>
          </div>
          <div class="sel-group">
            <div class="sel-group-header">
              <span class="stat-label">Hostname</span>
              <span class="sel-summary" id="i${id}-sel-hostname-summary"></span>
            </div>
            <select multiple size="6" id="i${id}-sel-hostname" class="server-select" disabled></select>
          </div>
          <div class="bool-filters" id="i${id}-bool-filters"></div>
          <div class="server-selector-footer">
            <small class="sel-hint">Ctrl/Cmd+click to select multiple. Nothing selected = Any.</small>
            <button id="i${id}-sel-apply" class="btn-apply" disabled>Apply</button>
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
  group.querySelector(`#i${id}-sel-country`).addEventListener('change', () => onCountryChange(id));
  group.querySelector(`#i${id}-sel-city`).addEventListener('change', () => onCityChange(id));
  group.querySelector(`#i${id}-sel-hostname`).addEventListener('change', () => updateSelSummary(id, 'hostname'));
  group.querySelector(`#i${id}-sel-apply`).addEventListener('click', () => applyServerSelection(id));
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
  if (s?.provider?.name) loadServerData(id, s.provider.server_selection ?? {});
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
  summary.textContent = selected.length ? selected.join(', ') : '';
}

function getHostnamesForCity(data, city) {
  for (const { byCity } of Object.values(data.byCountry)) {
    if (byCity[city]) return byCity[city];
  }
  return [];
}

function buildReverseMaps(data) {
  const cityToCountry = {}, hostnameToCity = {};
  for (const [country, { byCity }] of Object.entries(data.byCountry)) {
    for (const [city, hostnames] of Object.entries(byCity)) {
      cityToCountry[city] = country;
      for (const h of hostnames) hostnameToCity[h] = city;
    }
  }
  return { cityToCountry, hostnameToCity };
}

function resolveSelection(data, rawSel) {
  const { cityToCountry, hostnameToCity } = buildReverseMaps(data);
  let countries = [...(rawSel.countries ?? [])];
  let cities    = [...(rawSel.cities    ?? [])];
  let hostnames = [...(rawSel.hostnames ?? [])];
  if (!countries.length && cities.length)
    countries = [...new Set(cities.map(c => cityToCountry[c]).filter(Boolean))].sort();
  if (!cities.length && hostnames.length) {
    cities = [...new Set(hostnames.map(h => hostnameToCity[h]).filter(Boolean))].sort();
    if (!countries.length)
      countries = [...new Set(cities.map(c => cityToCountry[c]).filter(Boolean))].sort();
  }
  return { countries, cities, hostnames };
}

function onCountryChange(instanceId) {
  const data      = serverDataCache.get(instanceId);
  const countryEl = $(`i${instanceId}-sel-country`);
  const cityEl    = $(`i${instanceId}-sel-city`);
  const selected  = countryEl ? [...countryEl.selectedOptions].map(o => o.value) : [];

  cityEl.innerHTML = '';
  if (!data || !selected.length) {
    cityEl.add(Object.assign(new Option('Select a country first', ''), { disabled: true }));
  } else {
    selected.forEach(country => {
      if (!data.byCountry[country]) return;
      const grp = document.createElement('optgroup');
      grp.label = country;
      data.byCountry[country].cities.forEach(c => grp.appendChild(new Option(c, c)));
      cityEl.appendChild(grp);
    });
  }
  updateSelSummary(instanceId, 'country');
  onCityChange(instanceId);
}

function onCityChange(instanceId) {
  const data       = serverDataCache.get(instanceId);
  const cityEl     = $(`i${instanceId}-sel-city`);
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  const selected   = cityEl ? [...cityEl.selectedOptions].map(o => o.value) : [];

  hostnameEl.innerHTML = '';
  if (!data || !selected.length) {
    hostnameEl.add(Object.assign(new Option('Select a city first', ''), { disabled: true }));
  } else {
    selected.forEach(city => {
      const hostnames = getHostnamesForCity(data, city);
      if (!hostnames.length) return;
      const grp = document.createElement('optgroup');
      grp.label = city;
      hostnames.forEach(h => grp.appendChild(new Option(h, h)));
      hostnameEl.appendChild(grp);
    });
  }
  updateSelSummary(instanceId, 'city');
  updateSelSummary(instanceId, 'hostname');
}

function populateServerSelector(instanceId, data, currentSel = {}) {
  const { countries, cities, hostnames } = resolveSelection(data, currentSel);

  const providerEl = $(`i${instanceId}-sel-provider`);
  if (providerEl) providerEl.textContent = data.provider ?? '–';

  const countryEl = $(`i${instanceId}-sel-country`);
  countryEl.innerHTML = '';
  data.countries.forEach(c => countryEl.appendChild(new Option(c, c)));
  countryEl.disabled = false;
  [...countryEl.options].forEach(o => { o.selected = countries.includes(o.value); });

  onCountryChange(instanceId);

  const cityEl = $(`i${instanceId}-sel-city`);
  cityEl.disabled = false;
  [...cityEl.options].forEach(o => { o.selected = cities.includes(o.value); });

  onCityChange(instanceId);

  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  hostnameEl.disabled = false;
  [...hostnameEl.options].forEach(o => { o.selected = hostnames.includes(o.value); });

  const applyBtn = $(`i${instanceId}-sel-apply`);
  if (applyBtn) applyBtn.disabled = false;

  const boolContainer = $(`i${instanceId}-bool-filters`);
  if (boolContainer) {
    boolContainer.innerHTML = '';
    (data.booleanFilters ?? []).forEach(({ key, label }) => {
      const row = document.createElement('label');
      row.className = 'bool-filter-row';
      row.innerHTML = `<input type="checkbox" id="i${instanceId}-bool-${escHtml(key)}"> ${escHtml(label)}`;
      boolContainer.appendChild(row);
    });
  }

  serverSelectorReady.add(instanceId);
}

async function loadServerData(instanceId, currentSel) {
  if (serverSelectorReady.has(instanceId)) return;
  if (serverDataCache.has(instanceId)) {
    populateServerSelector(instanceId, serverDataCache.get(instanceId), currentSel);
    return;
  }
  try {
    const res  = await fetch(`/api/${instanceId}/servers`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? 'Failed to load server list');
    serverDataCache.set(instanceId, data);
    populateServerSelector(instanceId, data, currentSel);
  } catch (err) {
    const el = $(`i${instanceId}-sel-country`);
    if (el) { el.innerHTML = ''; el.appendChild(new Option('Unavailable', '')); }
    console.warn(`[server-selector][${instanceId}]`, err.message);
  }
}

async function applyServerSelection(instanceId) {
  const countryEl  = $(`i${instanceId}-sel-country`);
  const cityEl     = $(`i${instanceId}-sel-city`);
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  const applyBtn   = $(`i${instanceId}-sel-apply`);
  const inst       = instances.find(i => i.id === instanceId);
  const name       = inst?.name ?? instanceId;

  const countries = [...(countryEl?.selectedOptions  ?? [])].map(o => o.value);
  const cities    = [...(cityEl?.selectedOptions     ?? [])].map(o => o.value);
  const hostnames = [...(hostnameEl?.selectedOptions ?? [])].map(o => o.value);
  const data = serverDataCache.get(instanceId);
  const booleans = {};
  (data?.booleanFilters ?? []).forEach(({ key }) => {
    const el = $(`i${instanceId}-bool-${key}`);
    if (el) booleans[key] = el.checked;
  });

  applyBtn.disabled    = true;
  applyBtn.textContent = 'Applying…';
  showToast(`${name}: Applying server selection…`, 'info', 8000);

  try {
    const res  = await fetch(`/api/${instanceId}/vpn/settings`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ countries, cities, hostnames, booleans }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`${name}: Server selection applied`, 'success');
      setTimeout(async () => { await pollAll(); scheduleNextPoll(); }, 3000);
    } else {
      showToast(`${name}: ${data.error ?? 'Unknown error'}`, 'error', 5000);
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
