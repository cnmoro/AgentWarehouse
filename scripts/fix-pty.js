'use strict';
// After npm install: node-pty 1.1.0 ships its macOS helper (prebuilds/darwin-*/spawn-helper) without the execute bit,
// and every shell then fails to start with "posix_spawnp failed". Give it back. Nothing to do elsewhere.
const fs = require('fs');
const path = require('path');

if (process.platform === 'darwin') {
  let dir;
  try { dir = path.dirname(require.resolve('node-pty/package.json')); } catch { process.exit(0); }
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const f = path.join(dir, 'prebuilds', arch, 'spawn-helper');
    try { fs.chmodSync(f, 0o755); } catch { /* not in this version */ }
  }
}
