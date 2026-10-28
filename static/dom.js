// Small DOM, dialog and API helpers shared by the app modules.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (method !== 'GET') init.headers['X-Extraction-Tool'] = '1';
  if (body instanceof Blob) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let resp;
  try {
    resp = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('The local server is not responding. Is server.py still running?'), { status: 0 });
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { status: resp.status, data });
  return data;
}

// Resolves with the clicked action's value, or null when dismissed.
export function modal({ title, body, actions, dismissible = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const opener = document.activeElement;
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const primary = actions.find((a) => a.primary);
        if (primary) { e.preventDefault(); close(primary.value); }
      }
    };
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      h('h3', { id: 'modal-title' }, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, actions.map((a) =>
        h('button', { type: 'button', class: a.primary ? 'primary' : a.danger ? 'danger' : '', onclick: () => close(a.value) }, a.label))));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay && dismissible) close(null); } }, dialog);
    root.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (dialog.querySelector('input, textarea') || dialog.querySelector('button.primary') || dialog.querySelector('button'))?.focus();
  });
}

export function toast(message, kind = 'info', ms = 4000) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
