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
            <span class="stat-value" id="i${id}-sel-provider">–</span>
          </div>
          <div class="sel-acc-item" id="i${id}-acc-country">
            <div class="sel-acc-header">
              <span class="sel-acc-label">Country</span>
              <span class="sel-summary sel-summary-any" id="i${id}-sel-country-summary">Any</span>
              <button class="sel-clear-btn" title="Clear" tabindex="-1">&#10005;</button>
              <span class="sel-acc-arrow">&#9660;</span>
            </div>
            <div class="sel-acc-body">
              <select multiple size="7" id="i${id}-sel-country" class="server-select" disabled></select>
            </div>
          </div>
          <div class="sel-acc-item" id="i${id}-acc-city">
            <div class="sel-acc-header">
              <span class="sel-acc-label">City</span>
              <span class="sel-summary sel-summary-any" id="i${id}-sel-city-summary">Any</span>
              <button class="sel-clear-btn" title="Clear" tabindex="-1">&#10005;</button>
              <span class="sel-acc-arrow">&#9660;</span>
            </div>
            <div class="sel-acc-body">
              <select multiple size="7" id="i${id}-sel-city" class="server-select" disabled></select>
            </div>
          </div>
          <div class="sel-acc-item" id="i${id}-acc-hostname">
            <div class="sel-acc-header">
              <span class="sel-acc-label">Server</span>
              <span class="sel-summary sel-summary-any" id="i${id}-sel-hostname-summary">Any</span>
              <button class="sel-clear-btn" title="Clear" tabindex="-1">&#10005;</button>
              <span class="sel-acc-arrow">&#9660;</span>
            </div>
            <div class="sel-acc-body">
              <select multiple size="7" id="i${id}-sel-hostname" class="server-select" disabled></select>
            </div>
          </div>
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
  group.querySelector(`#i${id}-sel-country`).addEventListener('change', () => onCountryChange(id));
  group.querySelector(`#i${id}-sel-city`).addEventListener('change', () => onCityChange(id));
  group.querySelector(`#i${id}-sel-hostname`).addEventListener('change', () => updateSelSummary(id, 'hostname'));
  group.querySelector(`#i${id}-sel-apply`).addEventListener('click', () => applyServerSelection(id));
  group.querySelector(`#i${id}-sel-reset`).addEventListener('click', () => resetServerSelector(id));
  group.querySelector(`#i${id}-sel-isp`).addEventListener('change', () => onBooleanChange(id));
  group.querySelector(`#i${id}-isp-clear`).addEventListener('click', e => {
    e.stopPropagation();
    clearLevel(id, 'isp');
  });
  group.querySelector(`#i${id}-filters-clear`).addEventListener('click', e => {
    e.stopPropagation();
    clearFilters(id);
  });
  for (const level of ['country', 'city', 'hostname']) {
    const item = group.querySelector(`#i${id}-acc-${level}`);
    item.querySelector('.sel-acc-header').addEventListener('click', e => {
      if (!e.target.closest('.sel-clear-btn')) toggleAccordion(id, level);
    });
    item.querySelector('.sel-clear-btn').addEventListener('click', e => {
      e.stopPropagation();
      clearLevel(id, level);
    });
  }
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
    serverLastSelCache.set(id, s.provider.server_selection ?? {});
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

function getHostnamesForCity(data, city) {
  for (const { byCity } of Object.values(data.byCountry)) {
    if (byCity[city]) return byCity[city];
  }
  return [];
}

function getCheckedBooleans(instanceId, data) {
  return (data?.booleanFilters ?? [])
    .filter(({ key }) => $(`i${instanceId}-bool-${key}`)?.dataset.active === 'true')
    .map(({ key }) => key);
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

  // Build case-insensitive lookup maps: lowercase key → correctly-cased value from servers.json
  const countryMap = Object.fromEntries(data.countries.map(c => [c.toLowerCase(), c]));
  const cityMap    = Object.fromEntries(Object.keys(cityToCountry).map(c => [c.toLowerCase(), c]));

  const norm = (arr, map) =>
    (arr ?? []).map(v => map[v.trim().toLowerCase()]).filter(Boolean);

  let countries = norm(rawSel.countries, countryMap);
  let cities    = norm(rawSel.cities,    cityMap);
  let hostnames = (rawSel.hostnames ?? []).filter(Boolean);

  if (!countries.length && cities.length)
    countries = [...new Set(cities.map(c => cityToCountry[c]).filter(Boolean))].sort();
  if (!cities.length && hostnames.length) {
    cities = [...new Set(hostnames.map(h => hostnameToCity[h]).filter(Boolean))].sort();
    if (!countries.length)
      countries = [...new Set(cities.map(c => cityToCountry[c]).filter(Boolean))].sort();
  }
  return { countries, cities, hostnames };
}

function openAccordion(instanceId, level) {
  $(`i${instanceId}-acc-${level}`)?.classList.add('open');
}

function toggleAccordion(instanceId, level) {
  $(`i${instanceId}-acc-${level}`)?.classList.toggle('open');
}

function clearLevel(instanceId, level) {
  if (level === 'country') {
    const el = $(`i${instanceId}-sel-country`);
    if (el) [...el.options].forEach(o => o.selected = false);
    onCountryChange(instanceId);
  } else if (level === 'city') {
    const el = $(`i${instanceId}-sel-city`);
    if (el) [...el.options].forEach(o => o.selected = false);
    onCityChange(instanceId);
  } else if (level === 'isp') {
    const el = $(`i${instanceId}-sel-isp`);
    if (el) [...el.options].forEach(o => o.selected = false);
    onBooleanChange(instanceId);
  } else {
    const el = $(`i${instanceId}-sel-hostname`);
    if (el) [...el.options].forEach(o => o.selected = false);
    updateSelSummary(instanceId, 'hostname');
  }
}

function resetServerSelector(instanceId) {
  const data    = serverDataCache.get(instanceId);
  const lastSel = serverLastSelCache.get(instanceId) ?? {};
  if (!data) return;
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

function cityHasViableServers(data, city, filters) {
  const { checkedBools, selectedIsps } = filters;
  if (!checkedBools.length && !selectedIsps.length) return true;
  return getHostnamesForCity(data, city).some(h => hostnameMatchesFilters(data, h, filters));
}

function countryHasViableServers(data, country, filters) {
  return (data.byCountry[country]?.cities ?? []).some(city =>
    cityHasViableServers(data, city, filters)
  );
}

function onBooleanChange(instanceId) {
  const data      = serverDataCache.get(instanceId);
  const countryEl = $(`i${instanceId}-sel-country`);
  if (!data || !countryEl) return;

  const filters    = getFilters(instanceId, data);
  const prevSelected = new Set([...countryEl.selectedOptions].map(o => o.value));

  countryEl.innerHTML = '';
  data.countries
    .filter(c => countryHasViableServers(data, c, filters))
    .forEach(c => {
      const opt = new Option(c, c);
      opt.selected = prevSelected.has(c);
      countryEl.appendChild(opt);
    });

  updateIspChip(instanceId);
  onCountryChange(instanceId);
}

function onCountryChange(instanceId) {
  const data      = serverDataCache.get(instanceId);
  const countryEl = $(`i${instanceId}-sel-country`);
  const cityEl    = $(`i${instanceId}-sel-city`);
  const selected  = countryEl ? [...countryEl.selectedOptions].map(o => o.value) : [];
  const filters   = getFilters(instanceId, data);

  cityEl.innerHTML = '';
  if (!data || !selected.length) {
    cityEl.add(Object.assign(new Option('Select a country first', ''), { disabled: true }));
  } else {
    selected.forEach(country => {
      if (!data.byCountry[country]) return;
      const viableCities = data.byCountry[country].cities
        .filter(city => cityHasViableServers(data, city, filters));
      if (!viableCities.length) return;
      const grp = document.createElement('optgroup');
      grp.label = country;
      viableCities.forEach(c => grp.appendChild(new Option(c, c)));
      cityEl.appendChild(grp);
    });
    if (!cityEl.options.length)
      cityEl.add(Object.assign(new Option('No cities match current filters', ''), { disabled: true }));
  }
  updateSelSummary(instanceId, 'country');
  onCityChange(instanceId);
}

function onCityChange(instanceId) {
  const data       = serverDataCache.get(instanceId);
  const cityEl     = $(`i${instanceId}-sel-city`);
  const hostnameEl = $(`i${instanceId}-sel-hostname`);
  const selected   = cityEl ? [...cityEl.selectedOptions].map(o => o.value) : [];
  const filters    = getFilters(instanceId, data);

  hostnameEl.innerHTML = '';
  if (!data || !selected.length) {
    hostnameEl.add(Object.assign(new Option('Select a city first', ''), { disabled: true }));
  } else {
    selected.forEach(city => {
      let hostnames = getHostnamesForCity(data, city);
      if (filters.checkedBools.length || filters.selectedIsps.length) {
        hostnames = hostnames.filter(h => hostnameMatchesFilters(data, h, filters));
      }
      if (!hostnames.length) return;
      const grp = document.createElement('optgroup');
      grp.label = city;
      hostnames.forEach(h => grp.appendChild(new Option(data.hostnameLabels?.[h] ?? h, h)));
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
  const resetBtn = $(`i${instanceId}-sel-reset`);
  if (resetBtn) resetBtn.disabled = false;

  // ISP multi-select (inside filter bar)
  const ispSection = $(`i${instanceId}-isp-section`);
  const ispEl      = $(`i${instanceId}-sel-isp`);
  if (ispSection) ispSection.style.display = 'none'; // always reset to closed
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
  for (const l of ['country', 'city', 'hostname']) $(`i${instanceId}-acc-${l}`)?.classList.remove('open');

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
    const chip = $(`i${instanceId}-bool-${key}`);
    if (chip) booleans[key] = chip.dataset.active === 'true';
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
