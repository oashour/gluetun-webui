const { getConfigValue } = require('../config');

// instanceId → [{ index, providerName, vpnType, label, ...credentials }]
// Credentials are never sent to the client.
const providerConfigs = new Map();

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function parseProviders(prefix) {
  const list = [];
  for (let p = 1; p <= 10; p++) {
    const name = getConfigValue(`${prefix}_PROVIDER_${p}`, `${prefix.toLowerCase()}_provider_${p}`);
    if (!name) continue;

    const vpnType = (process.env[`${prefix}_PROVIDER_${p}_VPN_TYPE`] || 'wireguard').toLowerCase();
    const label   = process.env[`${prefix}_PROVIDER_${p}_LABEL`] || titleCase(name);
    const base    = { index: p, providerName: name.toLowerCase(), vpnType, label };

    if (vpnType === 'wireguard') {
      const wgKey = getConfigValue(`${prefix}_PROVIDER_${p}_WG_KEY`, `${prefix.toLowerCase()}_provider_${p}_wg_key`);
      if (!wgKey) { console.warn(`[config] ${prefix}_PROVIDER_${p} missing WG_KEY — skipping`); continue; }
      list.push({
        ...base,
        wgKey,
        wgAddresses: process.env[`${prefix}_PROVIDER_${p}_WG_ADDRESSES`] ?? null,
        wgPsk: getConfigValue(`${prefix}_PROVIDER_${p}_WG_PSK`, `${prefix.toLowerCase()}_provider_${p}_wg_psk`) || null,
      });
    } else if (vpnType === 'openvpn') {
      const g = (key, secret) => getConfigValue(`${prefix}_PROVIDER_${p}_${key}`, `${prefix.toLowerCase()}_provider_${p}_${secret}`);
      const ovpnUser = g('OVPN_USER', 'ovpn_user');
      const ovpnCert = g('OVPN_CERT', 'ovpn_cert');
      if (!ovpnUser && !ovpnCert) {
        console.warn(`[config] ${prefix}_PROVIDER_${p} (openvpn) has no credentials — skipping`);
        continue;
      }
      list.push({
        ...base,
        ovpnUser,
        ovpnPassword:      g('OVPN_PASSWORD',      'ovpn_password'),
        ovpnCert,
        ovpnKey:           g('OVPN_KEY',            'ovpn_key'),
        ovpnEncryptedKey:  g('OVPN_ENCRYPTED_KEY',  'ovpn_encrypted_key'),
        ovpnKeyPassphrase: g('OVPN_KEY_PASSPHRASE', 'ovpn_key_passphrase'),
      });
    } else {
      console.warn(`[config] ${prefix}_PROVIDER_${p}_VPN_TYPE=${vpnType} unknown — skipping`);
    }
  }
  return list;
}

// Populates providerConfigs for each instance.
// instances = [{ id, ... }] from core parseInstances().
// Mirrors core's numbered vs legacy detection: if GLUETUN_{id}_URL exists it's a
// numbered instance (prefix GLUETUN_{id}), otherwise it's the legacy fallback (prefix GLUETUN).
function parseAllProviders({ instances }) {
  for (const { id } of instances) {
    const prefix = getConfigValue(`GLUETUN_${id}_URL`, `gluetun_${id}_url`) ? `GLUETUN_${id}` : 'GLUETUN';
    providerConfigs.set(id, parseProviders(prefix));
  }
}

// Returns client-safe provider list (credentials stripped).
function getProvidersForInstance(id) {
  return (providerConfigs.get(id) ?? []).map(({ index, providerName, label, vpnType }) =>
    ({ index, providerName, label, vpnType })
  );
}

module.exports = { providerConfigs, parseAllProviders, getProvidersForInstance };
