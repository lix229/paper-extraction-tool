// Left pane: the PDF.js viewer for the cached PDF and supplements, or a fallback panel.
import { h, modal } from './dom.js';

const VIEWER = '/static/vendor/pdfjs/web/viewer.html';
const LOCATION_RE = /(?:Suppl\.\s+(.+?\.pdf)\s+)?p\.?\s*(\d+)/i;

// Applied to every PDF.js instance before it initialises.
document.addEventListener('webviewerloaded', (e) => {
  const opts = e.detail?.source?.PDFViewerApplicationOptions;
  if (!opts) return;
  opts.set('disablePreferences', true);
  opts.set('enableScripting', false);
  opts.set('isEvalSupported', false);
  opts.set('disableHistory', true);
  opts.set('defaultZoomValue', 'page-width');
  opts.set('sidebarViewOnLoad', 0);
  opts.set('annotationEditorMode', -1); // read-only: edits would never reach the cached file
});

export class Viewer {
  constructor({ tabs, stage, actions }) {
    Object.assign(this, { tabs, stage, actions });
    this.rid = null;
    this.file = 'main';
    this.iframe = null;
    this.src = null;
  }

  show(detail, { fetching = false } = {}) {
    if (detail.paper.record_id !== this.rid) {
      this.rid = detail.paper.record_id;
      this.file = 'main';
    }
    this.detail = detail;
    const files = this.files();
    if (!files.some((f) => f.key === this.file)) this.file = files[0]?.key ?? 'main';
    this.renderTabs(files, fetching);
    const file = files.find((f) => f.key === this.file);
    if (fetching || !file) this.renderPanel(fetching);
    else this.load(file);
  }

  files() {
    const { pdf, supplements, paper } = this.detail;
    const base = `/api/papers/${encodeURIComponent(paper.record_id)}`;
    const out = [];
    if (pdf.available) out.push({ key: 'main', label: 'Main PDF', url: `${base}/pdf?v=${(pdf.sha256 || '').slice(0, 12)}` });
    for (const s of supplements) out.push({ key: s.name, label: s.name, url: `${base}/supplements/${encodeURIComponent(s.name)}` });
    return out;
  }

  open(key, page) {
    const file = this.files().find((f) => f.key === key);
    if (!file) return false;
    this.file = key;
    this.renderTabs(this.files(), false);
    this.load(file, page);
    return true;
  }

  load(file, page) {
    const src = `${VIEWER}?file=${encodeURIComponent(file.url)}${page ? `#page=${page}` : ''}`;
    if (this.iframe?.isConnected && this.src === src) return;
    this.src = src;
    this.iframe = h('iframe', { class: 'pdf', title: `PDF viewer: ${file.label}`, src });
    this.iframe.addEventListener('load', () => this.interceptDrops());
    this.stage.replaceChildren(this.iframe);
  }

  renderTabs(files, fetching) {
    const has = (key) => files.some((f) => f.key === key);
    const picker = (kind, label) => {
      const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true,
        onchange: () => { if (input.files[0]) this.actions.upload(kind, input.files[0]); input.value = ''; } });
      return h('label', { class: 'button small' }, label, input);
    };
    this.tabs.replaceChildren(
      h('div', { class: 'file-tabs', role: 'tablist', 'aria-label': 'Files' }, files.map((f) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(f.key === this.file), class: 'tab', onclick: () => this.open(f.key) },
          f.key === 'main' ? f.label : `Suppl. ${f.label}`))),
      h('div', { class: 'file-actions' },
        has('main') ? picker('main', 'Replace PDF…') : null,
        picker('supplement', 'Add supplement…'),
        !has('main') && !fetching ? h('button', { type: 'button', class: 'small', onclick: () => this.actions.retry() }, 'Retry download') : null),
    );
  }

  renderPanel(fetching) {
    this.iframe = null;
    this.src = null;
    const { paper, pdf, match } = this.detail;
    const err = pdf.error;
    let status;
    if (fetching) {
      status = h('div', { class: 'state busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        'Looking the paper up in Semantic Scholar and downloading its open-access PDF…');
    } else if (err) {
      status = h('div', { class: 'state error' }, h('strong', {}, 'No PDF yet. '), err.reason,
        err.url ? [' ', h('a', { href: err.url, target: '_blank', rel: 'noopener' }, 'Link tried ↗')] : null);
    } else {
      status = h('div', { class: 'state' }, 'No PDF cached yet.');
    }
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true,
      onchange: () => input.files[0] && this.actions.upload('main', input.files[0]) });
    const drop = h('label', { class: 'dropzone' }, input,
      h('strong', {}, 'Drop the PDF here'), ' or ', h('span', { class: 'linkish' }, 'choose a file'),
      h('small', {}, 'Download it with your library access, then add it here. It is saved to the local cache.'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) this.actions.upload('main', file);
    });
    // an unconfirmed match may be a different paper, so only trust its text once confirmed
    const s2 = match?.confirmed ? match.paper || {} : {};
    const abstract = paper.abstract || s2.abstract;
    this.stage.replaceChildren(h('div', { class: 'fallback' },
      status,
      paper.source.url ? h('p', {}, h('a', { class: 'button', href: paper.source.url, target: '_blank', rel: 'noopener' }, 'Open publisher page ↗')) : null,
      fetching ? null : drop,
      s2.tldr?.text ? h('section', {}, h('h3', {}, 'TL;DR (Semantic Scholar)'), h('p', {}, s2.tldr.text)) : null,
      abstract ? h('section', {}, h('h3', {}, 'Abstract'), h('p', {}, abstract)) : null));
  }

  // PDF.js opens dropped files itself; route them to the cache instead.
  interceptDrops() {
    const win = this.iframe?.contentWindow;
    if (!win) return;
    const isFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    win.addEventListener('dragover', (e) => { if (isFile(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    win.addEventListener('drop', async (e) => {
      if (!isFile(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const choice = await modal({
        title: `Add “${file.name}”`,
        body: 'Replace the main PDF with this file, or keep it as a supplement?',
        actions: [{ label: 'Cancel', value: null }, { label: 'Add as supplement', value: 'supplement' }, { label: 'Replace main PDF', value: 'main', primary: true }],
      });
      if (choice) this.actions.upload(choice, file);
    }, true);
  }

  app() {
    const app = this.iframe?.contentWindow?.PDFViewerApplication;
    return app?.pdfDocument ? app : null;
  }

  // {label, page, text} for the page in view (or the page holding the selection).
  location() {
    const app = this.app();
    if (!app) return null;
    const win = this.iframe.contentWindow;
    let page = app.page;
    let text = '';
    const sel = win.getSelection();
    if (sel && !sel.isCollapsed) {
      text = sel.toString().replace(/\s+/g, ' ').trim();
      const node = sel.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      const pageNumber = el?.closest?.('.page')?.dataset.pageNumber;
      if (pageNumber) page = Number(pageNumber);
    }
    const label = this.file === 'main' ? `p. ${page}` : `Suppl. ${this.file} p. ${page}`;
    return { label, page, text };
  }

  goTo(text) {
    const m = LOCATION_RE.exec(text || '');
    if (!m) return false;
    const key = m[1] || 'main';
    const page = Number(m[2]);
    if (key !== this.file || !this.app()) return this.open(key, page);
    this.app().page = page;
    return true;
  }
}
