'use strict';
// SSH connections: a panel to keep a list of servers (host, port, user, and a
// password or a key file) and open any of them as a new session. The list
// lives on the server (lib/ssh.js); secrets are only ever sent to it, never
// back. Uses app.js's globals: $, state, activate, toast, setSidebar, mobile.

const Ssh = (() => {
  const s = { available: false, built: false, open: false, profiles: [], filter: '', editing: null, confirming: null };
  const el = {};

  async function api(method, path, body) {
    const res = await fetch(`/api/ssh${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.needPassphrase = !!data.needPassphrase; throw e; }
    return data;
  }

  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.flat().filter((x) => x != null && x !== false));
    return n;
  };

  function build() {
    if (s.built) return;
    s.built = true;
    el.root = $('#ssh');
    el.root.innerHTML = `
      <header class="ssh-head">
        <div class="ssh-title"><b>SSH connections</b><span class="ssh-sub">Opened from this machine</span></div>
        <input class="ssh-filter" type="search" placeholder="Filter…" aria-label="Filter connections" autocomplete="off" spellcheck="false">
        <span class="ssh-spacer"></span>
        <button class="tool-btn primary-btn" data-a="new">＋ New connection</button>
        <button class="icon-btn" data-a="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <div class="ssh-body"></div>`;
    el.body = el.root.querySelector('.ssh-body');
    el.filter = el.root.querySelector('.ssh-filter');
    el.root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') close();
      else if (a === 'new') edit({});
    });
    el.filter.addEventListener('input', () => { s.filter = el.filter.value.trim().toLowerCase(); renderList(); });
    el.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (s.editing) { s.editing = null; render(); } else close(); }
    });
  }

  async function load() {
    try { s.profiles = (await api('GET', '/profiles')).profiles; } catch (e) { toast(e.message); }
    render();
  }

  function render() {
    if (s.editing) renderForm(); else renderList();
    el.root.querySelector('.ssh-head').classList.toggle('editing', !!s.editing);
  }

  // ---------------------------------------------------------------- the list

  function renderList() {
    el.body.textContent = '';
    const f = s.filter;
    const shown = s.profiles
      .filter((p) => !f || `${p.name} ${p.username}@${p.host}`.toLowerCase().includes(f))
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
    if (!shown.length) {
      el.body.append(h('div', { class: 'ssh-empty' },
        h('p', {}, s.profiles.length ? 'No connection matches.' : 'No saved connections yet.'),
        !s.profiles.length && h('button', { class: 'primary', onclick: () => edit({}) }, 'New connection')));
      return;
    }
    const grid = h('div', { class: 'ssh-grid' });
    for (const p of shown) grid.append(card(p));
    el.body.append(grid);
  }

  function card(p) {
    const auth = [p.hasPassword && 'password', p.keyName && `key: ${p.keyName}`].filter(Boolean).join(' · ') || 'asks for the password';
    const confirming = s.confirming === p.id;
    return h('div', { class: 'ssh-card' },
      h('div', { class: 'ssh-card-main' },
        h('div', { class: 'ssh-name', title: p.name }, p.name),
        h('div', { class: 'ssh-addr' }, `${p.username}@${p.host}${p.port !== 22 ? `:${p.port}` : ''}`),
        h('div', { class: 'ssh-auth' }, auth)),
      confirming
        ? h('div', { class: 'ssh-card-actions' },
          h('span', { class: 'ssh-confirm' }, 'Delete this connection?'),
          h('button', { class: 'tool-btn danger', onclick: () => remove(p) }, 'Delete'),
          h('button', { class: 'tool-btn', onclick: () => { s.confirming = null; renderList(); } }, 'Keep'))
        : h('div', { class: 'ssh-card-actions' },
          h('button', { class: 'tool-btn primary-btn', onclick: (e) => connect(p, e.currentTarget) }, 'Connect'),
          h('button', { class: 'tool-btn', onclick: () => edit(p) }, 'Edit'),
          h('button', { class: 'tool-btn', title: 'Delete', 'aria-label': `Delete ${p.name}`, onclick: () => { s.confirming = p.id; renderList(); } }, '🗑')));
  }

  async function connect(p, btn) {
    btn.disabled = true;
    try {
      const { id } = await api('POST', `/profiles/${p.id}/connect`);
      p.lastUsed = Date.now();
      close({ keepFocus: true });
      // The session appears in the list a moment later; open it as soon as it does.
      if (state.tabs.some((t) => t.id === id)) activate(id); else state.pendingActivate = id;
      if (mobile.matches) setSidebar(false);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  }

  async function remove(p) {
    try {
      await api('DELETE', `/profiles/${p.id}`);
      s.profiles = s.profiles.filter((x) => x.id !== p.id);
      s.confirming = null;
      renderList();
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- the form

  function edit(p) { s.editing = { ...p, isNew: !p.id }; s.confirming = null; render(); }

  function renderForm() {
    const p = s.editing;
    let keyFile = null; // chosen in this form, not uploaded yet
    el.body.textContent = '';
    const input = (name, label, props = {}, hint = '') => {
      const i = h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', ...props });
      return { i, row: h('label', { class: 'ssh-field' }, h('span', { class: 'ssh-label' }, label), i, hint && h('span', { class: 'ssh-hint' }, hint)) };
    };
    const name = input('name', 'Name', { placeholder: 'Shown in the sidebar (default: user@host)', value: p.name || '' });
    const host = input('host', 'Host', { placeholder: 'example.com or 192.168.1.10', value: p.host || '', required: true });
    const port = input('port', 'Port', { type: 'number', min: 1, max: 65535, placeholder: '22', value: p.port && p.port !== 22 ? p.port : '' });
    const user = input('username', 'User', { placeholder: 'root', value: p.username || '', required: true });
    const pass = input('password', 'Password', {
      type: 'password', autocomplete: 'new-password',
      placeholder: p.hasPassword ? '•••••••• (saved; type to replace)' : 'Optional: leave empty to be asked each time',
    });
    const showPass = h('label', { class: 'ssh-check' }, h('input', { type: 'checkbox', onchange: (e) => { pass.i.type = e.target.checked ? 'text' : 'password'; } }), ' Show');
    const clearPass = p.hasPassword && h('label', { class: 'ssh-check' }, h('input', { type: 'checkbox', name: 'clearPassword' }), ' Forget the saved password');

    // The key file: choose or drop a .pem / .ppk / OpenSSH key; PuTTY keys are converted by the server.
    const keyInfo = h('div', { class: 'ssh-keyinfo' });
    const keyInput = h('input', { type: 'file', class: 'ssh-keyfile', 'aria-label': 'Key file' });
    const passphrase = input('passphrase', 'Key passphrase', { type: 'password', autocomplete: 'new-password', placeholder: 'Only if the key is protected' });
    const drop = h('div', { class: 'ssh-drop', tabindex: 0, role: 'button' });
    const showKey = () => {
      keyInfo.textContent = '';
      let text;
      if (keyFile) text = `${keyFile.name} (will be uploaded when you save${/\.ppk$/i.test(keyFile.name) ? ' and converted to OpenSSH format' : ''})`;
      else if (p.keyName && !p.removeKey) text = `${p.keyName}${p.keyFingerprint ? ` · ${p.keyFingerprint}` : ''}${p.keyEncrypted ? ' · passphrase protected' : ''}`;
      keyInfo.append(text ? h('span', {}, text) : h('span', { class: 'ssh-hint' }, 'No key file.'));
      if (keyFile || (p.keyName && !p.removeKey)) {
        keyInfo.append(h('button', { type: 'button', class: 'link-btn', onclick: () => { if (keyFile) keyFile = null; else p.removeKey = true; showKey(); } }, 'Remove'));
      }
      drop.textContent = keyFile || (p.keyName && !p.removeKey) ? 'Drop another key here, or click to replace it' : 'Drop a key file here (.pem, .ppk, id_rsa…), or click to choose';
    };
    const take = (file) => { if (file) { keyFile = file; p.removeKey = false; showKey(); } };
    keyInput.addEventListener('change', () => take(keyInput.files[0]));
    drop.addEventListener('click', () => keyInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); keyInput.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); });
    showKey();

    const msg = h('div', { class: 'ssh-error', role: 'alert', hidden: true });
    const fail = (text) => { msg.textContent = text; msg.hidden = false; };
    const save = h('button', { type: 'submit', class: 'tool-btn primary-btn' }, p.isNew ? 'Save' : 'Save changes');
    const form = h('form', { class: 'ssh-form', autocomplete: 'off', novalidate: true },
      h('h3', {}, p.isNew ? 'New connection' : `Edit ${p.name}`),
      name.row,
      h('div', { class: 'ssh-row' }, host.row, port.row),
      user.row,
      h('fieldset', { class: 'ssh-auth-box' }, h('legend', {}, 'Sign in with'),
        h('div', { class: 'ssh-hint' }, 'Fill in a password, a key file, or both. With neither, ssh asks you in the terminal each time.'),
        pass.row, h('div', { class: 'ssh-inline' }, showPass, clearPass),
        h('div', { class: 'ssh-field' }, h('span', { class: 'ssh-label' }, 'Key file'), drop, keyInfo, keyInput),
        passphrase.row),
      h('p', { class: 'ssh-hint' }, 'Passwords and passphrases are stored encrypted on this server and never sent back to this page. Key files are kept on the server with owner-only access.'),
      msg,
      h('div', { class: 'ssh-form-actions' }, save, h('button', { type: 'button', class: 'tool-btn', onclick: () => { s.editing = null; render(); } }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.hidden = true;
      save.disabled = true;
      try {
        const body = { name: name.i.value, host: host.i.value, port: port.i.value, username: user.i.value };
        if (pass.i.value) body.password = pass.i.value;
        else if (form.elements.clearPassword?.checked) body.password = null;
        let saved = p.isNew ? (await api('POST', '/profiles', body)).profile : (await api('PUT', `/profiles/${p.id}`, body)).profile;
        p.id = saved.id; p.isNew = false;
        if (keyFile) {
          const buf = new Uint8Array(await keyFile.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          const r = await api('PUT', `/profiles/${saved.id}/key`, { filename: keyFile.name, data: btoa(bin), passphrase: passphrase.i.value });
          saved = r.profile;
          if (r.converted) toast('PuTTY key converted to OpenSSH format', 2500);
        } else if (p.removeKey && p.keyName) {
          saved = (await api('DELETE', `/profiles/${saved.id}/key`)).profile;
        } else if (passphrase.i.value) {
          saved = (await api('PUT', `/profiles/${saved.id}`, { passphrase: passphrase.i.value })).profile;
        }
        s.profiles = [...s.profiles.filter((x) => x.id !== saved.id), saved];
        s.editing = null;
        render();
        toast('Saved', 1500);
      } catch (err) {
        // The connection itself is saved by now; only the key was refused.
        fail(err.message);
        if (err.needPassphrase) passphrase.i.focus();
        await load2();
      } finally {
        save.disabled = false;
      }
    });
    el.body.append(form);
    host.i.focus();
  }

  // After a partial save, learn the saved profile's state without leaving the form.
  async function load2() {
    try { s.profiles = (await api('GET', '/profiles')).profiles; } catch { /* keep what we have */ }
  }

  // ---------------------------------------------------------------- open / close

  function open() {
    if (!s.available) return;
    build();
    // One panel at a time.
    if (typeof Files !== 'undefined' && Files.isOpen()) Files.close({ keepFocus: true });
    if (typeof Vnc !== 'undefined' && Vnc.isOpen()) Vnc.close({ keepFocus: true });
    s.open = true;
    s.editing = null;
    s.confirming = null;
    el.root.hidden = false;
    if (mobile.matches) setSidebar(false);
    render();
    load();
    el.filter.focus();
  }

  function close({ keepFocus = false } = {}) {
    if (!s.open) return;
    s.open = false;
    s.editing = null;
    el.root.hidden = true;
    if (!keepFocus && typeof focusActive === 'function') focusActive();
  }

  function setAvailable(on) {
    s.available = on;
    for (const b of document.querySelectorAll('.ssh-btn')) b.hidden = !on;
    if (!on && s.open) close();
  }

  for (const b of document.querySelectorAll('.ssh-btn')) b.addEventListener('click', () => (s.open ? close() : open()));
  // Another panel opening takes the place of this one.
  for (const id of ['files', 'vnc']) {
    new MutationObserver(() => { if (!$(`#${id}`).hidden && s.open) close({ keepFocus: true }); })
      .observe($(`#${id}`), { attributes: true, attributeFilter: ['hidden'] });
  }

  return { open, close, setAvailable, isOpen: () => s.open };
})();
