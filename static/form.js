// Renders the extraction form from the normalized form.yaml and edits a values object in place.
import { h, modal, toast } from './dom.js';
import { evaluate, isFilled, isRequired, walk } from './conditions.js';

const OTHER = 'Other';
const CHIP_LIMIT = 9; // single selects with more options use a dropdown

const newId = () => Math.random().toString(36).slice(2, 10);
const asList = (v) => (Array.isArray(v) ? v : isFilled(v) ? [v] : []);
let uid = 0;
const domId = (prefix) => `${prefix}-${++uid}`;

export class FormView {
  constructor({ body, nav, scroller, viewer, onChange }) {
    Object.assign(this, { body, nav, scroller, viewer, onChange });
    this.collapsed = new Set();
    this.values = {};
    scroller.addEventListener('scroll', () => this.markActiveSection(), { passive: true });
  }

  setConfig(config) {
    this.config = config;
    this.groups = {};
    for (const s of config.sections) for (const f of s.fields) if (f.type === 'group') this.groups[f.id] = f;
  }

  load(paper, values) {
    this.paper = paper;
    this.values = structuredClone(values || {});
    this.collapsed.clear();
    this.render();
    this.scroller.scrollTop = 0;
  }

  // full rebuild; used on load and when group items are added or removed
  render() {
    const top = this.scroller.scrollTop;
    this.rows = [];
    this.refreshers = [];
    this.sections = [];
    this.hiddenBox = h('div', { class: 'notice hidden-values', hidden: true });
    this.body.replaceChildren(
      ...this.config.sections.map((s) => this.renderSection(s)),
      this.hiddenBox,
      this.renderOrphans(),
    );
    this.renderNav();
    this.refresh();
    this.scroller.scrollTop = top;
  }

  changed() {
    this.refresh();
    this.onChange();
  }

  refresh() {
    for (const s of this.sections) s.el.hidden = !evaluate(s.section.show_if, this.values);
    for (const r of this.rows) r.el.hidden = !r.visible();
    for (const fn of this.refreshers) fn();
    this.updateNav();
    this.renderHidden();
  }

  renderSection(section) {
    const sectionVisible = () => evaluate(section.show_if, this.values);
    const el = h('section', { class: 'fsection', id: `sec-${section.id}` },
      h('h2', {}, section.title),
      section.help ? h('p', { class: 'help' }, section.help) : null,
      h('div', { class: 'vtable' }, section.fields.map((f) => (f.type === 'group'
        ? this.renderGroup(f, sectionVisible)
        : this.renderRow(f, this.values, () => this.values, sectionVisible)))));
    this.sections.push({ section, el });
    return el;
  }

  renderRow(field, holder, scope, parentVisible) {
    const labelId = domId('lbl');
    const inputId = domId('in');
    const control = this.renderControl(field, holder, inputId, labelId);
    const required = field.required
      ? h('span', { class: 'req', title: field.required === true ? 'Required to mark Complete' : 'Required in some cases' }, '*')
      : null;
    const row = h('div', { class: 'frow', dataset: { field: field.id } },
      h('div', { class: 'flabel' },
        h('label', { id: labelId, for: inputId }, field.label, required),
        field.help ? h('div', { class: 'help' }, field.help) : null),
      h('div', { class: 'fcontrol' }, control.el));
    this.rows.push({ el: row, visible: () => parentVisible() && evaluate(field.show_if, scope()) });
    return row;
  }

  renderControl(field, holder, inputId, labelId) {
    if (field.type === 'select' || field.type === 'multiselect') return this.choiceControl(field, holder, inputId, labelId);
    if (field.type === 'ref') return this.refControl(field, holder, inputId, labelId);
    return this.textControl(field, holder, inputId);
  }

  setValue(holder, key, value) {
    if (isFilled(value)) holder[key] = value;
    else delete holder[key];
  }

  missingChips(field, isOn, toggle) {
    if (!field.missing.length) return { el: null, sync: () => {} };
    const chips = field.missing.map((m) => [m, h('button', { type: 'button', class: 'chip miss', 'aria-pressed': 'false', onclick: () => toggle(m) }, m)]);
    return {
      el: h('div', { class: 'chips missing', role: 'group', 'aria-label': 'Missing value' }, chips.map(([, c]) => c)),
      sync: () => { for (const [m, c] of chips) c.setAttribute('aria-pressed', String(isOn(m))); },
    };
  }

  choiceControl(field, holder, inputId, labelId) {
    const multiple = field.type === 'multiselect';
    const options = field.options;
    const get = () => holder[field.id];
    const chosen = (v) => asList(get()).includes(v);
    const set = (v) => {
      this.setValue(holder, field.id, v);
      if (field.other && !chosen(OTHER)) delete holder[`${field.id}_other`];
      sync();
      this.changed();
    };
    const toggle = (opt) => {
      if (!multiple) return set(get() === opt ? null : opt);
      const cur = Array.isArray(get()) ? get() : [];
      const next = cur.includes(opt) ? cur.filter((v) => v !== opt) : [...cur, opt];
      // keep option order; keep unknown saved values so they can be reviewed
      return set([...options.filter((o) => next.includes(o)), ...next.filter((v) => !options.includes(v))]);
    };

    const chips = [];
    let select = null;
    let optionsEl;
    if (!multiple && options.length > CHIP_LIMIT) {
      select = h('select', { id: inputId, 'aria-labelledby': labelId, onchange: () => set(select.value || null) },
        h('option', { value: '' }, '—'), options.map((o) => h('option', { value: o }, o)));
      optionsEl = select;
    } else {
      optionsEl = h('div', { class: 'chips', role: 'group', id: inputId, 'aria-labelledby': labelId }, options.map((o) => {
        const chip = h('button', { type: 'button', class: `chip${o === OTHER ? ' other' : ''}`, 'aria-pressed': 'false', onclick: () => toggle(o) }, o);
        chips.push([o, chip]);
        return chip;
      }));
    }
    const missing = this.missingChips(field, (m) => get() === m, (m) => set(get() === m ? null : m));
    const other = field.other ? h('input', {
      type: 'text', class: 'other-input', placeholder: 'Specify other', 'aria-label': `${field.label}: specify other`,
      oninput: () => { this.setValue(holder, `${field.id}_other`, other.value); this.changed(); },
    }) : null;
    const warn = h('div', { class: 'warn', hidden: true });

    const sync = () => {
      for (const [v, chip] of chips) chip.setAttribute('aria-pressed', String(chosen(v)));
      missing.sync();
      if (select) select.value = typeof get() === 'string' && options.includes(get()) ? get() : '';
      if (other) {
        other.hidden = !chosen(OTHER);
        other.value = holder[`${field.id}_other`] || '';
      }
      const bad = asList(get()).filter((v) => !options.includes(v) && !field.missing.includes(v));
      warn.hidden = !bad.length;
      warn.replaceChildren(...(bad.length ? [
        `Saved value not in the current options: ${bad.join('; ')}. `,
        h('button', { type: 'button', class: 'link', onclick: () => set(multiple ? asList(get()).filter((v) => !bad.includes(v)) : null) }, 'Clear'),
      ] : []));
    };
    sync();
    return { el: h('div', { class: 'choice' }, optionsEl, missing.el, other, warn), set };
  }

  textControl(field, holder, inputId) {
    const textarea = field.type === 'textarea';
    const input = textarea
      ? h('textarea', { id: inputId, rows: 2 })
      : h('input', { id: inputId, type: field.type === 'number' ? 'number' : 'text', step: field.type === 'number' ? 'any' : null });
    const get = () => holder[field.id];
    const isMissing = () => field.missing.includes(get());
    const write = (v) => this.setValue(holder, field.id, v);
    input.addEventListener('input', () => {
      if (field.type === 'number') {
        const n = input.value === '' ? null : Number(input.value);
        if (Number.isNaN(n)) return;
        write(n);
      } else {
        write(input.value);
      }
      missing.sync();
      input.placeholder = field.placeholder || '';
      this.changed();
    });
    const missing = this.missingChips(field, (m) => get() === m, (m) => { write(get() === m ? null : m); sync(); this.changed(); });
    const sync = () => {
      input.value = isMissing() || !isFilled(get()) ? '' : String(get());
      input.placeholder = isMissing() ? get() : field.placeholder || '';
      missing.sync();
    };
    const insert = (text, sep) => {
      const cur = isMissing() ? '' : String(get() || '');
      write(cur ? cur + sep + text : text);
      sync();
      this.changed();
    };

    const tools = [];
    if (field.evidence) {
      tools.push(
        h('button', { type: 'button', class: 'tool', title: 'Insert the page shown in the PDF viewer',
          onclick: () => { const loc = this.viewer.location(); loc ? insert(loc.label, '; ') : toast('Open the PDF first.', 'warn'); } }, 'Use page'),
        h('button', { type: 'button', class: 'tool', title: 'Show this location in the PDF viewer',
          onclick: () => { if (!this.viewer.goTo(input.value)) toast('No page to go to; locations look like "p. 7".', 'warn'); } }, 'Go to'),
      );
    }
    if (field.quote) {
      tools.push(h('button', { type: 'button', class: 'tool', title: 'Insert the text selected in the PDF as a labelled quotation',
        onclick: () => {
          const loc = this.viewer.location();
          if (!loc?.text) return toast('Select text in the PDF first.', 'warn');
          insert(`Quote (${loc.label}): "${loc.text}"`, '\n');
        } }, 'Insert selection'));
    }
    sync();
    return {
      el: h('div', { class: 'textctl' }, input, tools.length ? h('div', { class: 'tools' }, tools) : null, missing.el),
      set: (v) => { write(v); sync(); this.changed(); },
    };
  }

  itemCode(group, item) {
    const index = (this.values[group.id] || []).indexOf(item);
    return `${group.prefix}${index + 1}`;
  }

  itemSummary(group, item) {
    return group.summary.map((id) => asList(item[id]).join(', ')).filter(Boolean).join(' · ');
  }

  refControl(field, holder, inputId, labelId) {
    const group = this.groups[field.group];
    const items = () => this.values[field.group] || [];
    const get = () => asList(holder[field.id]);
    const set = (ids) => {
      this.setValue(holder, field.id, field.multiple ? ids : ids[0] ?? null);
      sync();
      this.changed();
    };
    const box = h('div', { class: 'ref', id: inputId, role: 'group', 'aria-labelledby': labelId });
    const warn = h('div', { class: 'warn', hidden: true });
    let signature = null;
    let chips = [];
    let select = null;

    const sync = () => {
      const known = new Set(items().map((it) => it._id));
      for (const [id, chip] of chips) chip.setAttribute('aria-pressed', String(get().includes(id)));
      if (select) select.value = known.has(get()[0]) ? get()[0] : '';
      const dangling = get().filter((id) => !known.has(id));
      warn.hidden = !dangling.length;
      warn.replaceChildren(...(dangling.length ? [
        'Links to a removed item. ',
        h('button', { type: 'button', class: 'link', onclick: () => set(get().filter((id) => known.has(id))) }, 'Clear'),
      ] : []));
    };
    const build = () => {
      const list = items();
      const sig = JSON.stringify(list.map((it) => [it._id, this.itemSummary(group, it)]));
      if (sig !== signature) {
        signature = sig;
        chips = [];
        select = null;
        const label = (it) => [this.itemCode(group, it), this.itemSummary(group, it)].filter(Boolean).join(' · ');
        if (!list.length) {
          box.replaceChildren(h('span', { class: 'muted' }, `No ${group.item_label}s yet; add one under “${group.label}”.`), warn);
        } else if (field.multiple) {
          box.replaceChildren(h('div', { class: 'chips' }, list.map((it) => {
            const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false',
              onclick: () => set(get().includes(it._id) ? get().filter((x) => x !== it._id) : [...get(), it._id]) }, label(it));
            chips.push([it._id, chip]);
            return chip;
          })), warn);
        } else {
          select = h('select', { 'aria-labelledby': labelId, onchange: () => set(select.value ? [select.value] : []) },
            h('option', { value: '' }, '—'), list.map((it) => h('option', { value: it._id }, label(it))));
          box.replaceChildren(select, warn);
        }
      }
      sync();
    };
    this.refreshers.push(build);
    build();
    return { el: box, set };
  }

  renderGroup(field, sectionVisible) {
    const visible = () => sectionVisible() && evaluate(field.show_if, this.values);
    const items = this.values[field.id] || [];
    const block = h('div', { class: 'group', dataset: { field: field.id } },
      h('div', { class: 'group-head' }, h('h3', {}, field.label), field.help ? h('div', { class: 'help' }, field.help) : null),
      items.map((item) => this.renderItem(field, item, visible)),
      h('button', { type: 'button', class: 'add', onclick: () => this.addItem(field) }, `+ Add ${field.item_label}`));
    this.rows.push({ el: block, visible });
    return block;
  }

  renderItem(field, item, groupVisible) {
    const summary = h('span', { class: 'item-summary' });
    const code = h('strong', {});
    this.refreshers.push(() => {
      code.textContent = this.itemCode(field, item);
      summary.textContent = this.itemSummary(field, item);
    });
    const details = h('details', { class: 'item', open: !this.collapsed.has(item._id), dataset: { item: item._id } },
      h('summary', {}, code, summary,
        h('button', { type: 'button', class: 'link danger', onclick: (e) => { e.preventDefault(); this.removeItem(field, item); } }, 'Remove')),
      h('div', { class: 'vtable' }, field.fields.map((sub) =>
        this.renderRow(sub, item, () => ({ ...this.values, ...item }), groupVisible))));
    details.addEventListener('toggle', () => (details.open ? this.collapsed.delete(item._id) : this.collapsed.add(item._id)));
    return details;
  }

  addItem(field) {
    const item = { _id: newId() };
    (this.values[field.id] ||= []).push(item);
    this.render();
    this.onChange();
    const el = this.body.querySelector(`[data-item="${item._id}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.querySelector('input, select, textarea, .chip')?.focus({ preventScroll: true });
  }

  refsTo(groupId, itemId) {
    const users = [];
    for (const e of walk(this.config, this.values)) {
      if (e.field.type === 'ref' && e.field.group === groupId && asList(e.holder[e.field.id]).includes(itemId)) users.push(e);
    }
    return users;
  }

  async removeItem(field, item) {
    const code = this.itemCode(field, item);
    const users = this.refsTo(field.id, item._id);
    const where = users.map((e) => (e.group ? `${e.group.prefix}${e.index + 1} ${e.field.label}` : e.field.label));
    const ok = await modal({
      title: `Remove ${code}?`,
      body: [h('p', {}, `This deletes the ${field.item_label} and everything entered in it.`),
        where.length ? h('p', {}, `It is linked from ${where.join(', ')}; those links will be cleared.`) : null],
      actions: [{ label: 'Cancel', value: false }, { label: `Remove ${code}`, value: true, danger: true }],
    });
    if (!ok) return;
    for (const e of users) {
      const rest = asList(e.holder[e.field.id]).filter((id) => id !== item._id);
      this.setValue(e.holder, e.field.id, e.field.multiple ? rest : rest[0] ?? null);
    }
    const items = this.values[field.id];
    items.splice(items.indexOf(item), 1);
    if (!items.length) delete this.values[field.id];
    this.render();
    this.onChange();
  }

  // values that the current config no longer has a field for
  orphans() {
    const known = (fields) => new Set(fields.flatMap((f) => (f.other ? [f.id, `${f.id}_other`] : [f.id])));
    const top = known(this.config.sections.flatMap((s) => s.fields));
    const out = Object.keys(this.values).filter((k) => !top.has(k)).map((k) => ({ label: k, holder: this.values, key: k }));
    for (const group of Object.values(this.groups)) {
      const subs = known(group.fields).add('_id');
      const items = Array.isArray(this.values[group.id]) ? this.values[group.id] : [];
      items.forEach((item, i) => {
        for (const k of Object.keys(item)) if (!subs.has(k)) out.push({ label: `${group.prefix}${i + 1} ${k}`, holder: item, key: k });
      });
    }
    return out;
  }

  renderOrphans() {
    const list = this.orphans();
    if (!list.length) return h('div', { hidden: true });
    return h('div', { class: 'notice orphans' },
      h('strong', {}, 'Saved values without a field in the current form.yaml'),
      h('p', { class: 'help' }, 'A field id was probably renamed or removed. Copy anything you need into the right field, then discard.'),
      h('ul', {}, list.map((o) => h('li', {},
        h('code', {}, o.label), ': ', JSON.stringify(o.holder[o.key]), ' ',
        h('button', { type: 'button', class: 'link danger', onclick: () => { delete o.holder[o.key]; this.render(); this.onChange(); } }, 'Discard')))));
  }

  hiddenEntries() {
    const out = [];
    const hiddenGroups = new Set();
    for (const e of walk(this.config, this.values)) {
      if (e.visible || !isFilled(e.holder[e.field.id])) continue;
      if (e.group && hiddenGroups.has(e.group.id)) continue;
      if (e.field.type === 'group') hiddenGroups.add(e.field.id);
      out.push(e);
    }
    return out;
  }

  renderHidden() {
    const list = this.hiddenEntries();
    this.hiddenBox.hidden = !list.length;
    if (!list.length) return;
    const names = list.map((e) => (e.group ? `${e.group.prefix}${e.index + 1} ${e.field.label}` : e.field.label));
    this.hiddenBox.replaceChildren(
      h('strong', {}, `${list.length} hidden field${list.length > 1 ? 's' : ''} still hold${list.length > 1 ? '' : 's'} values`),
      h('p', { class: 'help' }, `Kept in the saved record but exported blank: ${names.join(', ')}.`),
      h('button', { type: 'button', class: 'link danger', onclick: () => this.clearHidden() }, 'Clear these values'));
  }

  clearHidden() {
    for (const e of this.hiddenEntries()) {
      delete e.holder[e.field.id];
      delete e.holder[`${e.field.id}_other`];
    }
    this.render();
    this.onChange();
  }

  missingRequired() {
    const out = [];
    for (const e of walk(this.config, this.values)) {
      if (!e.visible || e.field.type === 'group' || isFilled(e.holder[e.field.id])) continue;
      if (!isRequired(e.field, e.holder, this.values)) continue;
      out.push(`${e.section.title} › ${e.group ? `${e.group.prefix}${e.index + 1} › ` : ''}${e.field.label}`);
    }
    return out;
  }

  renderNav() {
    this.navItems = this.config.sections.map((section) => ({
      section,
      el: h('button', { type: 'button', class: 'navchip', onclick: () => document.getElementById(`sec-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        section.title, h('span', { class: 'count' })),
    }));
    this.nav.replaceChildren(...this.navItems.map((n) => n.el));
  }

  updateNav() {
    const stats = {};
    for (const e of walk(this.config, this.values)) {
      if (!e.visible || e.field.type === 'group') continue;
      const st = (stats[e.section.id] ||= { total: 0, filled: 0, needs: 0 });
      st.total += 1;
      if (isFilled(e.holder[e.field.id])) st.filled += 1;
      else if (isRequired(e.field, e.holder, this.values)) st.needs += 1;
    }
    for (const { section, el } of this.navItems) {
      el.hidden = !evaluate(section.show_if, this.values);
      const st = stats[section.id];
      el.querySelector('.count').textContent = st ? `${st.filled}/${st.total}` : '';
      el.classList.toggle('needs', Boolean(st?.needs));
      el.title = st?.needs ? `${st.needs} required field${st.needs > 1 ? 's' : ''} empty` : '';
    }
    this.markActiveSection();
  }

  markActiveSection() {
    if (!this.navItems) return;
    const top = this.scroller.getBoundingClientRect().top + 24;
    let active = null;
    for (const { section, el } of this.sections) if (!el.hidden && el.getBoundingClientRect().top <= top) active = section.id;
    active ||= this.sections.find((s) => !s.el.hidden)?.section.id;
    for (const { section, el } of this.navItems) el.classList.toggle('active', section.id === active);
  }
}
