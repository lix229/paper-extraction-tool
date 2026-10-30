// Left pane: the PDF.js viewer and supplementary documents.
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
  opts.set('annotationEditorMode', -1); // read-only: evidence is recorded in the form
});

export class Viewer {
  constructor({ tabs, stage, actions }) {
    Object.assign(this, { tabs, stage, actions });
    this.rid = null;
    this.file = 'main';
    this.iframe = null;
    this.src = null;
  }

  show(detail) {
    if (detail.paper.record_id !== this.rid) {
      this.rid = detail.paper.record_id;
      this.file = 'main';
    }
    this.detail = detail;
    const files = this.files();
    if (!files.some((f) => f.key === this.file)) this.file = files[0]?.key ?? 'main';
    this.renderTabs(files);
    const file = files.find((f) => f.key === this.file);
    if (!file) this.renderPanel();
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
    this.renderTabs(this.files());
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

  renderTabs(files) {
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
        picker('main', has('main') ? 'Replace PDF…' : 'Add PDF…'),
        picker('supplement', 'Add supplement…')),
    );
  }

  renderPanel() {
    this.iframe = null;
    this.src = null;
    const { paper, pdf } = this.detail;
    const status = h('div', { class: 'state error' }, pdf.error?.reason || 'Add a PDF to read this paper.');
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true,
      onchange: () => input.files[0] && this.actions.upload('main', input.files[0]) });
    const drop = h('label', { class: 'dropzone' }, input,
      h('strong', {}, 'Drop the PDF here'), ' or ', h('span', { class: 'linkish' }, 'choose a file'),
      h('small', {}, 'The PDF is saved with your local work.'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) this.actions.upload('main', file);
    });
    this.stage.replaceChildren(h('div', { class: 'fallback' },
      status,
      paper.source.url ? h('p', {}, h('a', { class: 'button', href: paper.source.url, target: '_blank', rel: 'noopener' }, 'Open publisher page ↗')) : null,
      drop,
      paper.abstract ? h('section', {}, h('h3', {}, 'Abstract'), h('p', {}, paper.abstract)) : null));
  }

  // PDF.js opens dropped files itself; save them with the local work instead.
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
