import { api, formatTime, h, modal, toast } from './dom.js';
import { FormView } from './form.js';
import { Viewer } from './viewer.js';

const $ = (sel) => document.querySelector(sel);
const STATUS_CLASS = { 'Not started': 'st-none', 'In progress': 'st-progress', 'Needs review': 'st-review', Complete: 'st-done' };
const PDF_BADGE = { available: ['PDF', 'ok'], missing: ['No PDF', 'bad'] };
const SPLIT_KEY = 'extraction.split';
const LIST_KEY = 'extraction.listOpen';

const state = {
  config: null, settings: null, papers: [], rows: new Map(),
  current: null, detail: null, record: null,
};
let form;
let viewer;

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

// ---------- saving ----------

function setSaveState(kind, detail = '') {
  const el = $('#save-state');
  el.className = `save-state ${kind}`;
  el.textContent = { pending: 'Unsaved changes…', saving: 'Saving…', saved: `Saved ${formatTime(detail)}`, error: `Not saved: ${detail}` }[kind] || '';
}

const saver = {
  timer: null,
  dirty: false,
  inflight: null,
  mark() {
    this.dirty = true;
    setSaveState('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 700);
  },
  async save() {
    clearTimeout(this.timer);
    while (this.inflight) await this.inflight;
    if (!this.dirty) return true;
    this.dirty = false;
    const rid = state.current;
    const record = state.record;
    setSaveState('saving');
    let done;
    this.inflight = new Promise((resolve) => { done = resolve; });
    try {
      const saved = await api(`/api/records/${encodeURIComponent(rid)}`, {
        method: 'PUT', body: { rev: record.rev || 0, status: record.status, values: form.values },
      });
      Object.assign(record, { rev: saved.rev, updated_at: saved.updated_at, created_at: saved.created_at, reviewer: saved.reviewer });
      setSaveState('saved', saved.updated_at);
      updateRow({ record_id: rid, status: saved.status, updated_at: saved.updated_at });
      if (rid === state.current) renderRecordMeta();
    } catch (err) {
      this.dirty = true;
      this.inflight = null;
      done();
      if (err.status === 409) return resolveConflict(err.data.current);
      setSaveState('error', err.message);
      this.timer = setTimeout(() => this.save(), 5000);
      return false;
    }
    this.inflight = null;
    done();
    return this.dirty ? this.save() : true;
  },
  async flush() {
    if (!this.dirty && !this.inflight) return true;
    return this.save();
  },
};

async function resolveConflict(current) {
  setSaveState('error', 'changed in another tab');
  const choice = await modal({
    title: 'This paper changed in another tab',
    body: 'Its extraction was saved from another tab or window after you opened it here.',
    actions: [{ label: 'Load the saved version', value: 'load' }, { label: 'Keep my version', value: 'mine', primary: true }],
    dismissible: false,
  });
  if (choice === 'mine') {
    state.record.rev = current.rev;
    return saver.save();
  }
  saver.dirty = false;
  state.record = current;
  form.load(state.detail.paper, current.values);
  renderStatus();
  setSaveState('saved', current.updated_at);
  return true;
}

window.addEventListener('beforeunload', (e) => {
  if (!saver.dirty && !saver.inflight) return;
  if (saver.dirty) {
    fetch(`/api/records/${encodeURIComponent(state.current)}`, {
      method: 'PUT', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Extraction-Tool': '1' },
      body: JSON.stringify({ rev: state.record.rev || 0, status: state.record.status, values: form.values }),
    });
  }
  e.preventDefault();
  e.returnValue = '';
});

// ---------- paper list ----------

function renderList() {
  const list = $('#paper-list');
  list.replaceChildren(...state.papers.map((p) => {
    const li = h('li', {});
    state.rows.set(p.record_id, li);
    fillRow(li, p);
    return li;
  }));
  applyFilter();
}

function fillRow(li, p) {
  const [pdfText, pdfClass] = PDF_BADGE[p.pdf] || PDF_BADGE.missing;
  li.replaceChildren(h('button', {
    type: 'button', class: 'prow', 'aria-current': p.record_id === state.current ? 'true' : null,
    onclick: () => { openPaper(p.record_id); if (window.innerWidth < 1200) toggleList(false); },
  },
  h('span', { class: `dot ${STATUS_CLASS[p.status] || ''}`, title: p.status }),
  h('span', { class: 'ptitle' }, p.title),
  h('span', { class: 'pmeta' }, p.year, ' ', h('span', { class: `badge ${pdfClass}` }, pdfText))));
}

function updateRow(partial) {
  const p = state.papers.find((x) => x.record_id === partial.record_id);
  if (!p) return;
  Object.assign(p, partial);
  fillRow(state.rows.get(p.record_id), p);
  applyFilter();
}

function matchesFilter(p) {
  const q = $('#search').value.trim().toLowerCase();
  const f = $('#filter').value;
  if (q && ![p.title, p.authors, p.record_id, p.source_label].join(' ').toLowerCase().includes(q)) return false;
  if (f === 'all') return true;
  if (f === 'no-pdf') return p.pdf === 'missing';
  return p.status === f;
}

function visiblePapers() {
  return state.papers.filter(matchesFilter);
}

function applyFilter() {
  const shown = new Set(visiblePapers().map((p) => p.record_id));
  for (const [rid, li] of state.rows) li.hidden = !shown.has(rid);
  $('#list-count').textContent = `${shown.size} of ${state.papers.length} papers`;
  renderPosition();
}

function renderPosition() {
  const list = visiblePapers();
  const i = list.findIndex((p) => p.record_id === state.current);
  $('#position').textContent = i >= 0 ? `${i + 1} / ${list.length}` : `– / ${list.length}`;
  $('#prev').disabled = i <= 0;
  $('#next').disabled = i < 0 || i >= list.length - 1;
}

function step(delta) {
  const list = visiblePapers();
  const i = list.findIndex((p) => p.record_id === state.current);
  const next = list[i + delta];
  if (next) openPaper(next.record_id);
}

function toggleList(open) {
  const side = $('#sidebar');
  const show = open ?? side.hidden;
  side.hidden = !show;
  $('#toggle-list').setAttribute('aria-expanded', String(show));
  store.set(LIST_KEY, show ? '1' : '0');
  if (show) $('#search').focus();
}

// ---------- opening a paper ----------

async function openPaper(rid) {
  if (rid === state.current) return;
  if (!(await saver.flush())) {
    toast('This paper has unsaved changes that could not be saved; fix the problem before switching.', 'error', 6000);
    return;
  }
  const previous = state.current;
  state.current = rid;
  history.replaceState(null, '', `#/${rid}`);
  store.set('extraction.last', rid);
  for (const id of [previous, rid]) {
    const p = state.papers.find((x) => x.record_id === id);
    if (p) fillRow(state.rows.get(id), p);
  }
  renderPosition();
  let detail;
  try {
    detail = await api(`/api/papers/${encodeURIComponent(rid)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (state.current !== rid) return;
  state.detail = detail;
  state.record = detail.record || { rev: 0, status: 'Not started', values: {} };
  setSaveState(detail.record ? 'saved' : '', detail.record?.updated_at);
  renderHead();
  renderAbstract();
  renderStatus();
  form.load(detail.paper, state.record.values);
  viewer.show(detail);
}

function applyDetail(detail) {
  state.detail = { ...detail, record: state.detail?.record };
  renderHead();
  viewer.show(detail);
}

// ---------- paper header ----------

function shortAuthors(authors) {
  const list = authors.split(';').map((a) => a.trim()).filter(Boolean);
  return list.length > 3 ? `${list.slice(0, 3).join('; ')} et al.` : list.join('; ');
}

function renderHead() {
  const { paper, pdf } = state.detail;
  const source = paper.source.url
    ? h('a', { href: paper.source.url, target: '_blank', rel: 'noopener' }, `${paper.source.label} ↗`)
    : h('span', { class: 'muted' }, paper.source.label);
  $('#paper-head').replaceChildren(...[
    h('h1', {}, paper.title),
    h('div', { class: 'meta' }, h('span', { title: paper.authors }, shortAuthors(paper.authors)),
      ` · ${paper.year} · `, h('code', {}, paper.record_id), ' · ', source),
    pdf.origin === 'manual'
      ? h('div', { class: 'source-note' }, `PDF: ${pdf.filename || 'uploaded document'}`) : null,
  ].filter(Boolean));
}

// ---------- form side ----------

function renderAbstract() {
  const { paper } = state.detail;
  $('#paper-abstract').replaceChildren(...(paper.abstract ? [
    h('details', { class: 'abstract' }, h('summary', {}, 'Abstract'), h('p', {}, paper.abstract)),
  ] : []));
}

function renderStatus() {
  $('#status').replaceChildren(...state.settings.statuses.map((s) => h('button', {
    type: 'button', class: `seg ${STATUS_CLASS[s]}`, 'aria-pressed': String(state.record.status === s), onclick: () => setStatus(s),
  }, s)));
  renderRecordMeta();
}

function renderRecordMeta() {
  const r = state.record;
  $('#record-meta').textContent = r.updated_at ? `Last saved ${formatTime(r.updated_at)}${r.reviewer ? ` by ${r.reviewer}` : ''}` : 'Not saved yet';
}

async function setStatus(status) {
  if (status === state.record.status) return;
  if (status === 'Complete') {
    const missing = form.missingRequired();
    if (missing.length) {
      const ok = await modal({
        title: 'Required fields are empty',
        body: [h('p', {}, 'These shown fields are marked required:'), h('ul', { class: 'scroll-list' }, missing.map((m) => h('li', {}, m)))],
        actions: [{ label: 'Keep editing', value: false, primary: true }, { label: 'Mark Complete anyway', value: true }],
      });
      if (!ok) return;
    }
  }
  state.record.status = status;
  renderStatus();
  saver.mark();
}

function onFormChange() {
  if (state.record.status === 'Not started') {
    state.record.status = 'In progress';
    renderStatus();
  }
  saver.mark();
}

// ---------- uploads ----------

async function upload(kind, file) {
  const rid = state.current;
  const path = `/api/papers/${encodeURIComponent(rid)}/${kind === 'main' ? 'pdf' : 'supplements'}`;
  try {
    const before = new Set(state.detail.supplements.map((s) => s.name));
    const detail = await api(path, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) } });
    updateRow(detail.summary);
    if (state.current !== rid) return;
    applyDetail(detail);
    if (kind === 'main') {
      viewer.open('main');
      toast('PDF saved.');
    } else {
      const added = detail.supplements.find((s) => !before.has(s.name));
      if (added) viewer.open(added.name);
      toast(`Supplement saved${added ? ` as ${added.name}` : ''}.`);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- splitter ----------

function setupSplitter() {
  const split = $('#split');
  const bar = $('#splitter');
  const shield = $('#drag-shield');
  let ratio = Number(store.get(SPLIT_KEY)) || 0.55;
  const apply = (r) => {
    ratio = Math.min(0.8, Math.max(0.2, r));
    split.style.gridTemplateColumns = `minmax(260px, ${ratio}fr) 10px minmax(340px, ${1 - ratio}fr)`;
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  const end = (e) => {
    if (!bar.hasPointerCapture?.(e.pointerId)) return;
    bar.releasePointerCapture(e.pointerId);
    shield.hidden = true;
    document.body.classList.remove('resizing');
    store.set(SPLIT_KEY, String(ratio));
  };
  bar.setAttribute('aria-valuemin', '20');
  bar.setAttribute('aria-valuemax', '80');
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    shield.hidden = false; // the PDF iframe would otherwise swallow pointer events
    document.body.classList.add('resizing');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    const box = split.getBoundingClientRect();
    apply((e.clientX - box.left) / box.width);
  });
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => { apply(0.55); store.set(SPLIT_KEY, String(ratio)); });
  bar.addEventListener('keydown', (e) => {
    const delta = { ArrowLeft: -0.02, ArrowRight: 0.02 }[e.key];
    if (!delta) return;
    e.preventDefault();
    apply(ratio + delta);
    store.set(SPLIT_KEY, String(ratio));
  });
  apply(ratio);
}

// ---------- toolbar actions ----------

async function askReviewer(required) {
  const input = h('input', { type: 'text', class: 'wide', value: state.settings.reviewer || '', placeholder: 'Your name or initials' });
  for (;;) {
    const ok = await modal({
      title: 'Reviewer',
      body: [h('p', {}, 'Saved with every extraction record.'), input],
      actions: required ? [{ label: 'Save', value: true, primary: true }] : [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
      dismissible: !required,
    });
    if (!ok) return;
    if (!input.value.trim()) continue;
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { reviewer: input.value.trim() } });
      renderReviewer();
      return;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

function renderReviewer() {
  $('#reviewer').textContent = `Reviewer: ${state.settings.reviewer || '—'}`;
}

function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function exportCsv() {
  if (!(await saver.flush())) {
    toast('Save the current paper before exporting.', 'error');
    return;
  }
  const shown = visiblePapers();
  const filtered = shown.length !== state.papers.length;
  const choice = await modal({
    title: 'Export CSV',
    body: [
      h('p', {}, 'One row per paper. Repeatable items (contexts, datasets, findings…) become numbered columns; multi-select values are joined with "; ". Hidden fields export blank.'),
      h('p', {}, h('button', { type: 'button', class: 'link', onclick: () => download('/api/codebook.csv') }, 'Download the codebook'), ' to see what each column means.'),
    ],
    actions: [
      { label: 'Cancel', value: null },
      ...(filtered ? [{ label: `Papers in the list (${shown.length})`, value: 'shown' }] : []),
      { label: `All papers (${state.papers.length})`, value: 'all', primary: true },
    ],
  });
  if (!choice) return;
  const ids = choice === 'shown' ? shown.map((p) => p.record_id).join(',') : '';
  download(`/api/export.csv${ids ? `?ids=${encodeURIComponent(ids)}` : ''}`);
}

function showConfigErrors(err) {
  document.body.replaceChildren(h('main', { class: 'config-errors' },
    h('h1', {}, 'form.yaml has errors'),
    h('p', {}, 'Fix these in form.yaml, save, and reload the page.'),
    h('ul', {}, (err.data?.errors || [err.message]).map((e) => h('li', {}, e))),
    h('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, 'Reload')));
}

// ---------- start ----------

async function init() {
  setupSplitter();
  try {
    state.config = await api('/api/config');
  } catch (err) {
    showConfigErrors(err);
    return;
  }
  [state.settings, state.papers] = await Promise.all([api('/api/settings'), api('/api/papers')]);
  document.title = state.config.title;
  renderReviewer();

  viewer = new Viewer({
    tabs: $('#file-tabs'), stage: $('#viewer-stage'),
    actions: { upload },
  });
  form = new FormView({ body: $('#form-body'), nav: $('#section-nav'), scroller: $('#form-scroll'), viewer, onChange: onFormChange });
  form.setConfig(state.config);

  $('#toggle-list').addEventListener('click', () => toggleList());
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#search').addEventListener('input', applyFilter);
  $('#filter').addEventListener('change', applyFilter);
  $('#export').addEventListener('click', exportCsv);
  $('#reviewer').addEventListener('click', () => askReviewer(false));
  window.addEventListener('hashchange', () => {
    const rid = decodeURIComponent(location.hash.slice(2));
    if (state.rows.has(rid)) openPaper(rid);
  });

  renderList();
  toggleList(store.get(LIST_KEY) === '1');
  if (!state.settings.reviewer) await askReviewer(true);

  const fromHash = decodeURIComponent(location.hash.slice(2));
  const start = [fromHash, store.get('extraction.last')].find((rid) => state.rows.has(rid)) || state.papers[0]?.record_id;
  if (start) openPaper(start);
}

init();
