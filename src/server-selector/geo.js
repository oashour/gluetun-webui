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

module.exports = {
  PROVIDER_GEO_CONFIG,
  DEFAULT_GEO_HIERARCHY,
  OTHER_REGION,
  GEO_FIELD_LABELS,
  buildGeoTree,
  BOOLEAN_FILTER_MAP,
};
