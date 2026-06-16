const fs = require('fs');
const {
  PROVIDER_GEO_CONFIG, DEFAULT_GEO_HIERARCHY, GEO_FIELD_LABELS,
  buildGeoTree, BOOLEAN_FILTER_MAP,
} = require('./geo');
const { providerConfigs } = require('./providers');

const SERVERS_JSON_PATH = process.env.SERVERS_JSON_PATH || '/gluetun/servers.json';
const GEO_PLURAL_FIELDS = ['regions', 'countries', 'cities'];
const ALLOWED_BOOL_KEYS = new Set(BOOLEAN_FILTER_MAP.map(f => f.key));

let _serversCache = { mtimeMs: 0, data: null };
function readServersJson() {
  const { mtimeMs } = fs.statSync(SERVERS_JSON_PATH);
  if (mtimeMs !== _serversCache.mtimeMs) {
    _serversCache = { mtimeMs, data: JSON.parse(fs.readFileSync(SERVERS_JSON_PATH, 'utf8')) };
  }
  return _serversCache.data;
}

function registerRoutes(app, { resolveInstance, gluetunFetch, buildAuthHeadersFor, vpnActionLimiter }) {
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
      vpnType = cfg.vpnType;
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
      raw = readServersJson();
    } catch (err) {
      const missing = err.code === 'ENOENT';
      console.error('[servers]', missing ? `servers.json not found at ${SERVERS_JSON_PATH}` : err.message);
      return res.status(missing ? 404 : 500).json({
        ok: false,
        error: missing ? 'servers.json not found — check SERVERS_JSON_PATH' : 'Failed to read servers.json',
      });
    }

    const allServers = raw[providerName]?.servers ?? [];
    const servers = vpnType ? allServers.filter(s => s.vpn === vpnType) : allServers;

    const geoConfig     = PROVIDER_GEO_CONFIG[providerName] ?? { hierarchy: DEFAULT_GEO_HIERARCHY };
    const hierarchy     = geoConfig.hierarchy;
    const partialRegion = geoConfig.partial_region ?? false;
    const geoLevels     = hierarchy.map(field => ({ label: GEO_FIELD_LABELS[field] ?? field, field }));
    const geoTree       = buildGeoTree(servers, hierarchy, partialRegion);

    const booleanFilters = BOOLEAN_FILTER_MAP
      .filter(({ field }) => servers.some(s => s[field]))
      .map(({ key, label }) => ({ key, label }));

    const hostnameFlags = {};
    const hostnameLabels = {};
    const hostnameIsps = {};
    const ispSet = new Set();
    for (const s of servers) {
      if (!s.hostname) continue;
      const flags = BOOLEAN_FILTER_MAP.filter(({ field }) => s[field]).map(({ key }) => key);
      if (flags.length) hostnameFlags[s.hostname] = flags;
      const labelPrefix = s.server_name ?? s.name ?? (s.number != null ? String(s.number) : null);
      if (labelPrefix) hostnameLabels[s.hostname] = `${labelPrefix} (${s.hostname})`;
      if (s.isp) { hostnameIsps[s.hostname] = s.isp; ispSet.add(s.isp); }
    }
    const isps = [...ispSet].sort();

    res.json({ ok: true, provider: providerName, geoLevels, geoTree, booleanFilters, hostnameFlags, hostnameLabels, hostnameIsps, isps });
  });

  // --- Per-instance VPN settings (server selection) ---
  // Registered BEFORE /vpn/:action so Express doesn't match 'settings' as :action.
  app.put('/api/:instanceId/vpn/settings', vpnActionLimiter, async (req, res) => {
    const instance = resolveInstance(req.params.instanceId);
    if (!instance) return res.status(400).json({ ok: false, error: 'Unknown instance ID' });

    const body = req.body ?? {};
    const isStrArr = v => Array.isArray(v) && v.every(x => typeof x === 'string');
    const geoSels = {};
    for (const field of GEO_PLURAL_FIELDS) {
      const val = body[field] ?? [];
      if (!isStrArr(val)) return res.status(400).json({ ok: false, error: `${field} must be an array of strings` });
      geoSels[field] = val;
    }
    const hostnames = body.hostnames ?? [];
    if (!isStrArr(hostnames)) return res.status(400).json({ ok: false, error: 'hostnames must be an array of strings' });
    const booleans = body.booleans ?? {};
    if (
      typeof booleans !== 'object' || Array.isArray(booleans) || booleans === null ||
      Object.entries(booleans).some(([k, v]) => !ALLOWED_BOOL_KEYS.has(k) || typeof v !== 'boolean')
    ) {
      return res.status(400).json({ ok: false, error: 'Invalid booleans object' });
    }

    let upstream;
    const providerIndex = body.providerIndex != null ? Number(body.providerIndex) : null;
    if (providerIndex !== null) {
      const cfg = (providerConfigs.get(instance.id) ?? []).find(p => p.index === providerIndex);
      if (!cfg) return res.status(400).json({ ok: false, error: 'Provider not found' });

      let credentialBlock;
      if (cfg.vpnType === 'wireguard') {
        credentialBlock = {
          wireguard: {
            private_key:    cfg.wgKey,
            addresses:      cfg.wgAddresses ? cfg.wgAddresses.split(',').map(s => s.trim()) : [],
            pre_shared_key: cfg.wgPsk ?? '',
          },
        };
      } else {
        credentialBlock = {
          openvpn: {
            user:           cfg.ovpnUser          ?? '',
            password:       cfg.ovpnPassword      ?? '',
            cert:           cfg.ovpnCert          ?? '',
            key:            cfg.ovpnKey           ?? '',
            encrypted_key:  cfg.ovpnEncryptedKey  ?? '',
            key_passphrase: cfg.ovpnKeyPassphrase ?? '',
          },
        };
      }

      upstream = {
        type: cfg.vpnType,
        provider: { name: cfg.providerName, server_selection: { vpn: cfg.vpnType, ...geoSels, hostnames, ...booleans } },
        ...credentialBlock,
      };
    } else {
      upstream = { provider: { server_selection: { ...geoSels, hostnames, ...booleans } } };
    }

    try {
      await gluetunFetchText(instance, '/v1/vpn/settings', 'PUT', upstream);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[upstream][${instance.id}]`, err.message);
      res.status(502).json({ ok: false, error: 'Upstream error' });
    }
  });
}

module.exports = { registerRoutes };
