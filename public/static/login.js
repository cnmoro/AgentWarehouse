'use strict';
const form = document.getElementById('login');
const error = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  error.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    if (res.ok) {
      location.replace('/');
      return;
    }
    const body = await res.json().catch(() => ({}));
    error.textContent = body.error || `Sign-in failed (${res.status})`;
    error.hidden = false;
    form.password.value = '';
    form.password.focus();
  } catch {
    error.textContent = 'Could not reach the server.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
