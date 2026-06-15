const fs = require('fs');

function getConfigValue(envVar, secretName = null) {
  const secretPath = `/run/secrets/${secretName || envVar.toLowerCase()}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch (_) {}
  return process.env[envVar] || '';
}

module.exports = { getConfigValue };
