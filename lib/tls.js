'use strict';
// HTTPS=1: the server speaks HTTPS with a self-signed certificate that it makes
// itself (DATA_DIR/tls/), so browsers treat the page as a secure context
// (microphone, WebCodecs, async clipboard) without a domain or a tailnet
// certificate. The browser warns once per device and address until the
// certificate is accepted. HTTPS_CERT and HTTPS_KEY use your own pair instead.
//
// The certificate names every address and host name the server accepts. When
// that list changes (another LISTEN_ALSO, a new Tailscale name), or the
// certificate has under 30 days left, a new one is made. The key is mode 0600.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DAYS = 825;

function load() {
  if (process.env.HTTPS_CERT || process.env.HTTPS_KEY) {
    if (!(process.env.HTTPS_CERT && process.env.HTTPS_KEY)) throw new Error('HTTPS_CERT and HTTPS_KEY must be set together.');
    return { cert: fs.readFileSync(process.env.HTTPS_CERT), key: fs.readFileSync(process.env.HTTPS_KEY), own: true };
  }
  return null;
}

function ensure(dataDir, hosts) {
  const own = load();
  if (own) return own;
  const dir = path.join(dataDir, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const listFile = path.join(dir, 'names.txt');
  const names = [...new Set([...hosts, 'localhost', '127.0.0.1', os.hostname()].map((h) => String(h).trim()).filter(Boolean))].sort();
  const want = names.join('\n');

  const fresh = () => {
    try {
      if (fs.readFileSync(listFile, 'utf8') !== want) return false;
      const x = new crypto.X509Certificate(fs.readFileSync(certFile));
      return new Date(x.validTo).getTime() - Date.now() > 30 * 86400 * 1000 && fs.existsSync(keyFile);
    } catch { return false; }
  };

  if (!fresh()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const san = names.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256',
        '-days', String(DAYS), '-subj', '/CN=Agent Warehouse', '-addext', `subjectAltName=${san}`,
        '-addext', 'keyUsage=digitalSignature', '-addext', 'extendedKeyUsage=serverAuth',
        '-keyout', keyFile, '-out', certFile,
      ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 });
    } catch (e) {
      throw new Error(`HTTPS=1 needs the openssl command to make a certificate (${e.code === 'ENOENT' ? 'not found' : String(e.stderr || e.message).trim().split('\n').pop()}).`);
    }
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(listFile, want);
    console.log(`Made a self-signed certificate in ${dir} for: ${names.join(', ')}`);
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), own: false };
}

module.exports = { ensure };
