import { api, formatTime, h, modal, toast } from './dom.js';
import { FormView } from './form.js';
import { Viewer } from './viewer.js';

const $ = (sel) => document.querySelector(sel);
const STATUS_CLASS = { 'Not started': 'st-none', 'In progress': 'st-progress', 'Needs review': 'st-review', Complete: 'st-done' };
const PDF_BADGE = { cached: ['PDF', 'ok'], manual: ['PDF (added)', 'ok'], failed: ['No PDF', 'bad'], none: ['Not fetched', 'muted'] };
const SPLIT_KEY = 'extraction.split';
const LIST_KEY = 'extraction.listOpen';

const state = {
  config: null, settings: null, papers: [], rows: new Map(),
  current: null, detail: null, record: null, fetches: new Map(),
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
  const [pdfText, pdfClass] = PDF_BADGE[p.pdf] || PDF_BADGE.none;
  li.replaceChildren(h('button', {
    type: 'button', class: 'prow', 'aria-current': p.record_id === state.current ? 'true' : null,
    onclick: () => { openPaper(p.record_id); if (window.innerWidth < 1200) toggleList(false); },
  },
  h('span', { class: `dot ${STATUS_CLASS[p.status] || ''}`, title: p.status }),
  h('span', { class: 'ptitle' }, p.title),
  h('span', { class: 'pmeta' }, [p.year, p.aspect].filter(Boolean).join(' · '), ' ',
    h('span', { class: `badge ${pdfClass}` }, pdfText),
    p.match_unconfirmed ? h('span', { class: 'badge warn', title: 'Semantic Scholar match needs checking' }, 'Check match') : null)));
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
  if (f === 'no-pdf') return p.pdf === 'failed' || p.pdf === 'none';
  if (f === 'check-match') return p.match_unconfirmed || p.match === 'not_found';
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
  renderScreening();
  renderStatus();
  form.load(detail.paper, state.record.values);
  viewer.show(detail);
  const { pdf, match } = detail;
  const shouldFetch = !pdf.available && (!pdf.error || pdf.error.transient) && match?.status !== 'none';
  if (shouldFetch || state.fetches.has(rid)) fetchPaper(rid).catch((err) => toast(err.message, 'error'));
}

function fetchPaper(rid, retry = false) {
  if (!state.fetches.has(rid)) {
    const request = api(`/api/papers/${encodeURIComponent(rid)}/fetch${retry ? '?retry=1' : ''}`, { method: 'POST' })
      .then((detail) => {
        updateRow(detail.summary);
        if (state.current === rid) applyDetail(detail);
        if (detail.s2_key_rejected) warnKeyRejected();
        return detail;
      })
      .catch((err) => {
        if (state.current === rid) viewer.show(state.detail);
        throw err;
      })
      .finally(() => state.fetches.delete(rid));
    state.fetches.set(rid, request);
  }
  if (state.current === rid) viewer.show(state.detail, { fetching: true });
  return state.fetches.get(rid);
}

let keyWarned = false;
function warnKeyRejected() {
  if (keyWarned) return;
  keyWarned = true;
  toast('Semantic Scholar rejected the API key, so lookups use the shared, rate-limited pool. Check SEMANTIC_SCHOLAR_API_KEY.', 'warn', 10000);
}

function applyDetail(detail) {
  state.detail = { ...detail, record: state.detail?.record };
  renderHead();
  viewer.show(detail);
}

// ---------- paper header and match ----------

function shortAuthors(authors) {
  const list = authors.split(';').map((a) => a.trim()).filter(Boolean);
  return list.length > 3 ? `${list.slice(0, 3).join('; ')} et al.` : list.join('; ');
}

function renderHead() {
  const { paper, match, pdf } = state.detail;
  const s2 = match?.paper;
  const links = [
    paper.source.url ? h('a', { href: paper.source.url, target: '_blank', rel: 'noopener' }, `${paper.source.label} ↗`) : h('span', { class: 'badge warn' }, paper.source.label),
    s2?.url ? h('a', { href: s2.url, target: '_blank', rel: 'noopener' }, 'Semantic Scholar ↗') : null,
  ].filter(Boolean);
  $('#paper-head').replaceChildren(...[
    h('h1', {}, paper.title),
    h('div', { class: 'meta' }, h('span', { title: paper.authors }, shortAuthors(paper.authors)), ` · ${paper.year} · `, h('code', {}, paper.record_id), ' · ',
      links.flatMap((l, i) => (i ? [' · ', l] : [l]))),
    matchBanner(match),
    pdfBadge(pdf, s2),
  ].filter(Boolean));
}

function matchBanner(match) {
  if (!match) return null;
  const change = h('button', { type: 'button', class: 'small', onclick: changeMatch }, 'Use another identifier…');
  if (match.status === 'not_found') {
    return h('div', { class: 'banner warn' }, `Not found in Semantic Scholar (tried ${match.tried.join(', ')}). `, change,
      h('button', { type: 'button', class: 'small', onclick: () => postMatch({ action: 'none' }) }, 'Mark as not in Semantic Scholar'));
  }
  if (match.status === 'none') return h('div', { class: 'banner' }, 'Marked as not in Semantic Scholar. ', change);
  if (match.confirmed) return null;
  const s2 = match.paper;
  const first = s2.authors?.[0]?.name;
  const how = { title: 'title search', doi: 'DOI', pmid: 'PubMed id', manual: 'the identifier you entered' }[match.method] || match.method;
  return h('div', { class: 'banner warn' },
    h('div', {}, `Matched by ${how}; title similarity ${Math.round(match.similarity * 100)}%. Is this the paper? `,
      h('strong', {}, `“${s2.title}”`), ` (${[s2.year, first].filter(Boolean).join(', ')}${s2.venue ? `, ${s2.venue}` : ''})`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'small primary', onclick: () => postMatch({ action: 'confirm' }) }, 'Yes, confirm'),
      change,
      h('button', { type: 'button', class: 'small', onclick: () => postMatch({ action: 'none' }) }, 'Not in Semantic Scholar')));
}

function pdfBadge(pdf, s2) {
  if (!pdf.available) return null;
  if (pdf.origin === 'manual') return h('div', { class: 'source-note' }, `PDF added by hand${pdf.filename ? ` (${pdf.filename})` : ''}.`);
  const host = (() => { try { return new URL(pdf.final_url || pdf.url).host; } catch { return ''; } })();
  const oa = pdf.oa_status || s2?.openAccessPdf?.status;
  const note = h('div', { class: 'source-note' }, `Open-access PDF${oa ? ` (${oa})` : ''} from ${host}.`);
  if (oa === 'GREEN') {
    note.append(h('span', { class: 'badge warn' }, 'Repository/preprint copy: page numbers may differ from the published article'));
  }
  return note;
}

async function postMatch(body) {
  const rid = state.current;
  try {
    const detail = await api(`/api/papers/${encodeURIComponent(rid)}/match`, { method: 'POST', body });
    updateRow(detail.summary);
    if (state.current === rid) applyDetail(detail);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function changeMatch() {
  const input = h('input', { type: 'text', class: 'wide', placeholder: '10.1000/xyz, PubMed URL, arXiv id or semanticscholar.org link' });
  const ok = await modal({
    title: 'Match a different Semantic Scholar paper',
    body: [h('p', {}, 'Paste a DOI, PubMed id or URL, arXiv id, or a Semantic Scholar paper link. A PDF added by hand is kept; a downloaded one is replaced.'), input],
    actions: [{ label: 'Cancel', value: false }, { label: 'Look up', value: true, primary: true }],
  });
  if (ok && input.value.trim()) await postMatch({ action: 'identifier', identifier: input.value.trim() });
}

// ---------- form side ----------

function renderScreening() {
  const { paper } = state.detail;
  const rows = Object.entries(paper.screening).filter(([, v]) => v);
  const brief = ['review_aspect', 'publication_type', 'country'].map((k) => paper.screening[k]).filter(Boolean).join(' · ');
  $('#screening').replaceChildren(h('details', { class: 'screening' },
    h('summary', {}, 'Original screening (workbook)', brief ? h('span', { class: 'muted' }, ` — ${brief}`) : null),
    h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k.replaceAll('_', ' ')), h('td', {}, v))))),
    paper.abstract ? h('details', { class: 'abstract' }, h('summary', {}, 'Abstract'), h('p', {}, paper.abstract)) : null));
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
      toast('PDF saved to the cache.');
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

async function fetchMissing() {
  const untried = state.papers.filter((p) => p.pdf === 'none');
  const failed = state.papers.filter((p) => p.pdf === 'failed');
  const retry = h('input', { type: 'checkbox' });
  const go = await modal({
    title: 'Fetch missing PDFs',
    body: [
      h('p', {}, `${untried.length} paper${untried.length === 1 ? ' has' : 's have'} not been tried yet. Semantic Scholar allows one request a second, so this takes a few seconds per paper.`),
      failed.length ? h('label', { class: 'check' }, retry, ` Also retry the ${failed.length} that failed before`) : null,
    ],
    actions: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }],
  });
  if (!go) return;
  const queue = retry.checked ? [...untried, ...failed] : untried;
  if (!queue.length) return toast('Nothing to fetch.');
  let cancelled = false;
  const bar = h('progress', { max: queue.length, value: 0 });
  const line = h('p', { class: 'muted' });
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fetching PDFs' },
    h('h3', {}, 'Fetching PDFs'), bar, line,
    h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => { cancelled = true; line.textContent = 'Stopping after this paper…'; } }, 'Stop'))));
  $('#modal-root').append(overlay);
  let got = 0;
  let missed = 0;
  for (const [i, p] of queue.entries()) {
    if (cancelled) break;
    line.textContent = `${i + 1} of ${queue.length}: ${p.title}`;
    try {
      const detail = await fetchPaper(p.record_id, p.pdf === 'failed');
      detail.pdf.available ? got++ : missed++;
    } catch {
      missed++;
    }
    bar.value = i + 1;
  }
  overlay.remove();
  toast(`${got} PDF${got === 1 ? '' : 's'} downloaded, ${missed} without a PDF${cancelled ? ' (stopped early)' : ''}. Filter the list by “No PDF” to add the rest by hand.`, 'info', 8000);
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
    actions: { upload, retry: () => fetchPaper(state.current, true).catch((err) => toast(err.message, 'error')) },
  });
  form = new FormView({ body: $('#form-body'), nav: $('#section-nav'), scroller: $('#form-scroll'), viewer, onChange: onFormChange });
  form.setConfig(state.config);

  $('#toggle-list').addEventListener('click', () => toggleList());
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#search').addEventListener('input', applyFilter);
  $('#filter').addEventListener('change', applyFilter);
  $('#export').addEventListener('click', exportCsv);
  $('#fetch-missing').addEventListener('click', fetchMissing);
  $('#reviewer').addEventListener('click', () => askReviewer(false));
  window.addEventListener('hashchange', () => {
    const rid = decodeURIComponent(location.hash.slice(2));
    if (state.rows.has(rid)) openPaper(rid);
  });

  renderList();
  toggleList(store.get(LIST_KEY) === '1');
  if (!state.settings.reviewer) await askReviewer(true);
  if (!state.settings.has_api_key) toast('No Semantic Scholar API key found; lookups use the shared, rate-limited pool.', 'warn', 8000);
  if (state.settings.api_key_rejected) warnKeyRejected();

  const fromHash = decodeURIComponent(location.hash.slice(2));
  const start = [fromHash, store.get('extraction.last')].find((rid) => state.rows.has(rid)) || state.papers[0]?.record_id;
  if (start) openPaper(start);
}

init();
