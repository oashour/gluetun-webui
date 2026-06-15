const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const SERVERS_JSON_PATH = process.env.SERVERS_JSON_PATH || '/gluetun/servers.json';

// Per-provider geo hierarchy config. hierarchy = ordered fields top→bottom above server.
// partial_region = true means some servers lack the region field → bucket into OTHER_REGION.
const PROVIDER_GEO_CONFIG = {
  'airvpn':                  { hierarchy: ['region', 'country', 'city'] },
  'nordvpn':                 { hierarchy: ['region', 'country', 'city'] },
  'slickvpn':                { hierarchy: ['region', 'country', 'city'] },
  'surfshark':               { hierarchy: ['region', 'country', 'city'] },
  'hidemyass':               { hierarchy: ['country', 'region', 'city'], partial_region: true },
  'ivpn':                    { hierarchy: ['country', 'region', 'city'], partial_region: true },
  'vpnsecure':               { hierarchy: ['country', 'region', 'city'], partial_region: true },
  'privado':                 { hierarchy: ['country', 'region', 'city'] },
  'purevpn':                 { hierarchy: ['country', 'region', 'city'] },
  'windscribe':              { hierarchy: ['region', 'city'] },
  'giganews':                { hierarchy: ['region'] },
  'vyprvpn':                 { hierarchy: ['region'] },
  'private internet access': { hierarchy: ['region'] },
  'cyberghost':              { hierarchy: ['country'] },
  'expressvpn':              { hierarchy: ['country', 'city'] },
  'fastestvpn':              { hierarchy: ['country', 'city'] },
  'ipvanish':                { hierarchy: ['country', 'city'] },
  'mullvad':                 { hierarchy: ['country', 'city'] },
  'privatevpn':              { hierarchy: ['country', 'city'] },
  'protonvpn':               { hierarchy: ['country', 'city'] },
  'torguard':                { hierarchy: ['country', 'city'] },
  'vpn unlimited':           { hierarchy: ['country', 'city'] },
  'perfect privacy':         { hierarchy: ['city'] },
};
const DEFAULT_GEO_HIERARCHY = ['country', 'city'];
const OTHER_REGION          = 'Other Region';
const GEO_FIELD_LABELS      = { region: 'Region', country: 'Country', city: 'City' };

function buildGeoTree(servers, hierarchy, partialRegion) {
  const tree = {};
  for (const s of servers) {
    if (!s.hostname) continue;
    const path = [];
    let skip = false;
    for (const field of hierarchy) {
      const val = s[field];
      if (!val) {
        if (partialRegion && field === 'region') { path.push(OTHER_REGION); }
        else { skip = true; break; }
      } else { path.push(val); }
    }
    if (skip) continue;
    let node = tree;
    for (let i = 0; i < path.length - 1; i++) {
      if (!node[path[i]]) node[path[i]] = {};
      node = node[path[i]];
    }
    const leaf = path[path.length - 1];
    if (!node[leaf]) node[leaf] = [];
    node[leaf].push(s.hostname);
  }
  return sortGeoTree(tree, hierarchy.length);
}

function sortGeoTree(obj, depth) {
  if (depth <= 1 || Array.isArray(obj)) return obj;
  const keys = Object.keys(obj).sort((a, b) =>
    a === OTHER_REGION ? 1 : b === OTHER_REGION ? -1 : a.localeCompare(b)
  );
  const out = {};
  for (const k of keys) out[k] = sortGeoTree(obj[k], depth - 1);
  return out;
}

const BOOLEAN_FILTER_MAP = [
  { field: 'owned',        key: 'owned_only',        label: 'Owned' },
  { field: 'free',         key: 'free_only',         label: 'Free' },
  { field: 'premium',      key: 'premium_only',      label: 'Premium' },
  { field: 'stream',       key: 'stream_only',       label: 'Stream' },
  { field: 'multihop',     key: 'multi_hop_only',    label: 'Multi-hop' },
  { field: 'port_forward', key: 'port_forward_only', label: 'Port forward' },
  { field: 'secure_core',  key: 'secure_core_only',  label: 'Secure core' },
  { field: 'tor',          key: 'tor_only',          label: 'Tor' },
];

// --- Docker Secrets Support ---
// Try to read from /run/secrets/ (Docker Swarm/Compose secrets), fall back to env vars
function getConfigValue(envVar, secretName = null) {
  const secretPath = `/run/secrets/${secretName || envVar.toLowerCase()}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch (_) {}
  return process.env[envVar] || '';
}

// instanceId → [{ index, providerName, label, wgKey, wgAddresses, wgPsk }]
// Populated by parseInstances(); credentials never sent to the client.
const providerConfigs = new Map();

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// Parse GLUETUN_<prefix>_PROVIDER_P vars (P = 1..10) for a given prefix.
// prefix = "GLUETUN_1" (numbered instance) or "GLUETUN" (legacy single-instance).
function parseProviders(prefix) {
  const list = [];
  for (let p = 1; p <= 10; p++) {
    const name = getConfigValue(`${prefix}_PROVIDER_${p}`, `${prefix.toLowerCase()}_provider_${p}`);
    if (!name) continue;
    const wgKey = getConfigValue(`${prefix}_PROVIDER_${p}_WG_KEY`, `${prefix.toLowerCase()}_provider_${p}_wg_key`);
    if (!wgKey) { console.warn(`[config] ${prefix}_PROVIDER_${p} has no WG_KEY — skipping`); continue; }
    list.push({
      index: p,
      providerName: name.toLowerCase(),
      label: process.env[`${prefix}_PROVIDER_${p}_LABEL`] || titleCase(name),
      wgKey,
      wgAddresses: process.env[`${prefix}_PROVIDER_${p}_WG_ADDRESSES`] ?? null,
      wgPsk: getConfigValue(`${prefix}_PROVIDER_${p}_WG_PSK`, `${prefix.toLowerCase()}_provider_${p}_wg_psk`) || null,
    });
  }
  return list;
}

// --- Multi-instance configuration ---
// Define multiple gluetun instances via numbered env vars:
//   GLUETUN_1_URL, GLUETUN_1_NAME, GLUETUN_1_API_KEY, GLUETUN_1_USER, GLUETUN_1_PASSWORD
//   GLUETUN_2_URL, GLUETUN_2_NAME, ...
// Or via Docker secrets: gluetun_1_url, gluetun_1_api_key, etc.
// Falls back to legacy single-instance vars (GLUETUN_CONTROL_URL, GLUETUN_API_KEY, etc.)
function parseInstances() {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const url = getConfigValue(`GLUETUN_${i}_URL`, `gluetun_${i}_url`);
    if (!url) continue;
    // Validate URL at startup (fail-fast)
    try {
      new URL(url);
    } catch (err) {
      console.error(`[startup] Invalid GLUETUN_${i}_URL: ${url}`);
      process.exit(1);
    }
    const id = String(i);
    list.push({
      id,
      name: getConfigValue(`GLUETUN_${i}_NAME`, `gluetun_${i}_name`) || `Instance ${i}`,
      url: url.replace(/\/$/, ''),
      apiKey:   getConfigValue(`GLUETUN_${i}_API_KEY`, `gluetun_${i}_api_key`),
      user:     getConfigValue(`GLUETUN_${i}_USER`, `gluetun_${i}_user`),
      password: getConfigValue(`GLUETUN_${i}_PASSWORD`, `gluetun_${i}_password`),
    });
    providerConfigs.set(id, parseProviders(`GLUETUN_${i}`));
  }
  if (list.length === 0) {
    // Legacy single-instance fallback
    const legacyUrl = getConfigValue('GLUETUN_CONTROL_URL', 'gluetun_control_url') || 'http://gluetun:8000';
    // Validate URL at startup (fail-fast)
    try {
      new URL(legacyUrl);
    } catch (err) {
      console.error(`[startup] Invalid GLUETUN_CONTROL_URL: ${legacyUrl}`);
      process.exit(1);
    }
    list.push({
      id: '1',
      name: getConfigValue('GLUETUN_NAME', 'gluetun_name') || 'Gluetun',
      url: legacyUrl.replace(/\/$/, ''),
      apiKey:   getConfigValue('GLUETUN_API_KEY', 'gluetun_api_key'),
      user:     getConfigValue('GLUETUN_USER', 'gluetun_user'),
      password: getConfigValue('GLUETUN_PASSWORD', 'gluetun_password'),
    });
    providerConfigs.set('1', parseProviders('GLUETUN'));
  }
  return list;
}

const instances = parseInstances();
const instanceMap = new Map(instances.map(inst => [inst.id, inst]));

function buildAuthHeadersFor(instance) {
  if (instance.apiKey) {
    return { 'X-API-Key': instance.apiKey };
  }
  if (instance.user && instance.password) {
    const encoded = Buffer.from(`${instance.user}:${instance.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

function resolveInstance(id) {
  return instanceMap.get(id) || null;
}

// General read rate limiter (covers all /api/* GET routes)
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// UI/static route rate limiter – protects filesystem access for SPA index.html
const uiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests for the web UI, please try again later.',
});

app.use('/api/', (req, res, next) => req.method === 'GET' ? readLimiter(req, res, next) : next());

// Security headers
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2kb' }));
app.use(uiLimiter, express.static(path.join(__dirname, 'public')));

async function gluetunFetch(instance, endpoint, method = 'GET', body = null) {
  const url = `${instance.url}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const opts = {
    method,
    signal: controller.signal,
    redirect: 'error',
    headers: {
      ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      ...buildAuthHeadersFor(instance),
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gluetun returned ${res.status}${text ? ': ' + text.slice(0, 200).trim() : ''}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function gluetunFetchText(instance, endpoint, method = 'GET', body = null) {
  const url = `${instance.url}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const opts = {
    method,
    signal: controller.signal,
    redirect: 'error',
    headers: {
      ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      ...buildAuthHeadersFor(instance),
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gluetun returned ${res.status}${text ? ': ' + text.slice(0, 200).trim() : ''}`);
    }
    return res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Helper: aggregate health for one instance ---
// Returns { timestamp, vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, allFailed }
// allFailed = true if ALL 5 checks failed (service is completely unreachable)
async function fetchInstanceHealth(instance) {
  const results = await Promise.allSettled([
    gluetunFetch(instance, '/v1/vpn/status'),
    gluetunFetch(instance, '/v1/publicip/ip'),
    gluetunFetch(instance, '/v1/portforward'),
    gluetunFetch(instance, '/v1/dns/status'),
    gluetunFetch(instance, '/v1/vpn/settings'),
  ]);
  results.forEach(r => { if (r.status === 'rejected') console.error(`[upstream][${instance.id}]`, r.reason?.message); });
  const [vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings] = results.map(r =>
    r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: 'Upstream error' }
  );
  const allFailed = results.every(r => r.status === 'rejected');
  return { timestamp: new Date().toISOString(), vpnStatus, publicIp, portForwarded, dnsStatus, vpnSettings, allFailed };
}

// --- Instance list endpoint ---
app.get('/api/instances', (req, res) => {
  res.json(instances.map(({ id, name }) => ({
    id,
    name,
    providers: (providerConfigs.get(id) ?? []).map(({ index, providerName, label }) =>
      ({ index, providerName, label })
    ),
  })));
});

// --- Per-instance health endpoint ---
app.get('/api/:instanceId/health', async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  const health = await fetchInstanceHealth(instance);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
});

// --- Legacy aggregate health (instance 1) ---
app.get('/api/health', async (req, res) => {
  const health = await fetchInstanceHealth(instances[0]);
  // Return 503 if all upstream checks failed (service completely unreachable)
  if (health.allFailed) {
    return res.status(503).json({ ok: false, error: 'Service unavailable', ...health });
  }
  res.json({ ok: true, ...health });
});

// --- Legacy individual proxy endpoints (instance 1) ---
app.get('/api/status', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/vpn/status');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/publicip', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/publicip/ip');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/portforwarded', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/portforward');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/vpn/settings');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

app.get('/api/dns', async (req, res) => {
  try {
    const data = await gluetunFetch(instances[0], '/v1/dns/status');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// VPN control actions
const vpnActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// Rate limiting for SPA/static index route
const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later.' },
});

// --- Per-instance server list (reads servers.json from disk) ---
app.get('/api/:instanceId/servers', async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });

  let providerName, vpnType;
  const providerIndex = req.query.providerIndex ? Number(req.query.providerIndex) : null;

  if (providerIndex !== null) {
    const cfg = (providerConfigs.get(instance.id) ?? []).find(p => p.index === providerIndex);
    if (!cfg) return res.status(400).json({ ok: false, error: 'Provider not found' });
    providerName = cfg.providerName;
    vpnType = 'wireguard';
  } else {
    let settings;
    try {
      settings = await gluetunFetch(instance, '/v1/vpn/settings');
    } catch (err) {
      console.error(`[upstream][${instance.id}]`, err.message);
      return res.status(502).json({ ok: false, error: 'Upstream error' });
    }
    providerName = settings?.provider?.name;
    vpnType = settings?.type;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SERVERS_JSON_PATH, 'utf8'));
  } catch (err) {
    const missing = err.code === 'ENOENT';
    console.error('[servers]', err.message);
    return res.status(missing ? 404 : 500).json({
      ok: false,
      error: missing
        ? `servers.json not found at ${SERVERS_JSON_PATH}. Mount it from your gluetun container and set SERVERS_JSON_PATH if needed.`
        : 'Failed to read servers.json',
    });
  }

  const allServers = raw[providerName]?.servers ?? [];
  const servers = vpnType
    ? allServers.filter(s => s.vpn === vpnType)
    : allServers;

  const geoConfig    = PROVIDER_GEO_CONFIG[providerName] ?? { hierarchy: DEFAULT_GEO_HIERARCHY };
  const hierarchy    = geoConfig.hierarchy;
  const partialRegion = geoConfig.partial_region ?? false;
  const geoLevels    = hierarchy.map(field => ({ label: GEO_FIELD_LABELS[field] ?? field, field }));
  const geoTree      = buildGeoTree(servers, hierarchy, partialRegion);

  const booleanFilters = BOOLEAN_FILTER_MAP
    .filter(({ field }) => servers.some(s => s[field]))
    .map(({ key, label }) => ({ key, label }));

  // Map hostname -> array of boolean keys that are truthy for that server
  const hostnameFlags = {};
  for (const s of servers) {
    if (!s.hostname) continue;
    const flags = BOOLEAN_FILTER_MAP.filter(({ field }) => s[field]).map(({ key }) => key);
    if (flags.length) hostnameFlags[s.hostname] = flags;
  }

  // Map hostname -> display label (only when a server_name / name / number prefix is available)
  const hostnameLabels = {};
  for (const s of servers) {
    if (!s.hostname) continue;
    const prefix = s.server_name ?? s.name ?? (s.number != null ? String(s.number) : null);
    if (prefix) hostnameLabels[s.hostname] = `${prefix} (${s.hostname})`;
  }

  // ISP support: map hostname -> isp + sorted unique list
  const hostnameIsps = {};
  const ispSet = new Set();
  for (const s of servers) {
    if (!s.hostname || !s.isp) continue;
    hostnameIsps[s.hostname] = s.isp;
    ispSet.add(s.isp);
  }
  const isps = [...ispSet].sort();

  res.json({ ok: true, provider: providerName, geoLevels, geoTree, booleanFilters, hostnameFlags, hostnameLabels, hostnameIsps, isps });
});

// --- Per-instance VPN settings (server selection) ---
// Must be registered BEFORE /vpn/:action to prevent Express matching 'settings' as :action
app.put('/api/:instanceId/vpn/settings', vpnActionLimiter, async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });

  const body = req.body ?? {};
  const isStrArr = v => Array.isArray(v) && v.every(x => typeof x === 'string');
  const GEO_PLURAL_FIELDS = ['regions', 'countries', 'cities'];
  const geoSels = {};
  for (const field of GEO_PLURAL_FIELDS) {
    const val = body[field] ?? [];
    if (!isStrArr(val)) return res.status(400).json({ ok: false, error: `${field} must be an array of strings` });
    geoSels[field] = val;
  }
  const hostnames = body.hostnames ?? [];
  if (!isStrArr(hostnames)) return res.status(400).json({ ok: false, error: 'hostnames must be an array of strings' });
  const booleans = body.booleans ?? {};
  const allowedBoolKeys = new Set(BOOLEAN_FILTER_MAP.map(f => f.key));
  if (
    typeof booleans !== 'object' || Array.isArray(booleans) || booleans === null ||
    Object.entries(booleans).some(([k, v]) => !allowedBoolKeys.has(k) || typeof v !== 'boolean')
  ) {
    return res.status(400).json({ ok: false, error: 'Invalid booleans object' });
  }

  let upstream;
  const providerIndex = body.providerIndex != null ? Number(body.providerIndex) : null;
  if (providerIndex !== null) {
    const cfg = (providerConfigs.get(instance.id) ?? []).find(p => p.index === providerIndex);
    if (!cfg) return res.status(400).json({ ok: false, error: 'Provider not found' });
    const wireguard = { private_key: cfg.wgKey };
    if (cfg.wgAddresses) wireguard.addresses = cfg.wgAddresses.split(',').map(s => s.trim());
    if (cfg.wgPsk != null) wireguard.pre_shared_key = cfg.wgPsk;
    upstream = {
      type: 'wireguard',
      provider: { name: cfg.providerName, server_selection: { vpn: 'wireguard', ...geoSels, hostnames, ...booleans } },
      wireguard,
    };
  } else {
    upstream = { provider: { server_selection: { ...geoSels, hostnames, ...booleans } } };
  }

  try {
    const text = await gluetunFetchText(instance, '/v1/vpn/settings', 'PUT', upstream);
    res.json({ ok: true, message: text });
  } catch (err) {
    console.error(`[upstream][${instance.id}]`, err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// --- Per-instance VPN control ---
app.put('/api/:instanceId/vpn/:action', vpnActionLimiter, async (req, res) => {
  const instance = resolveInstance(req.params.instanceId);
  if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });
  const { action } = req.params;
  const allowed = ['start', 'stop'];
  if (!allowed.includes(action)) {
    return res.status(400).json({ ok: false, error: 'Invalid action. Use start or stop.' });
  }
  try {
    const data = await gluetunFetch(
      instance,
      '/v1/vpn/status',
      'PUT',
      { status: action === 'start' ? 'running' : 'stopped' }
    );
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[upstream][${instance.id}]`, err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// --- Legacy VPN control (instance 1) ---
app.put('/api/vpn/:action', vpnActionLimiter, async (req, res) => {
  const { action } = req.params;
  const allowed = ['start', 'stop'];
  if (!allowed.includes(action)) {
    return res.status(400).json({ ok: false, error: 'Invalid action. Use start or stop.' });
  }
  try {
    const data = await gluetunFetch(
      instances[0],
      '/v1/vpn/status',
      'PUT',
      { status: action === 'start' ? 'running' : 'stopped' }
    );
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[upstream]', err.message);
    res.status(502).json({ ok: false, error: 'Upstream error' });
  }
});

// 404 for undefined /api/* routes – must come before SPA catch-all
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.get('*', staticLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler – catches synchronous throws and next(err) calls
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Gluetun Web UI running on port ${PORT}`);
  instances.forEach(inst => console.log(`  [${inst.id}] ${inst.name} → ${inst.url}`));
});
