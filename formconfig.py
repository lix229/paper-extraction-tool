"""Load, validate and evaluate the extraction form config (form.yaml).

The normalized config is what the browser receives: named conditions are
inlined, "Other" is appended to option lists, and every field carries its
missing-value list. static/conditions.js mirrors evaluate() and walk().
"""
import hashlib
import re

import yaml

FIELD_TYPES = {'select', 'multiselect', 'text', 'textarea', 'number', 'ref', 'group'}
CHOICE_TYPES = {'select', 'multiselect'}
OTHER = 'Other'
ID_RE = re.compile(r'^[a-z][a-z0-9_]*$')
FIELD_KEYS = {'id', 'label', 'type', 'help', 'options', 'other', 'missing', 'show_if', 'required',
              'evidence', 'quote', 'placeholder', 'fields', 'prefix', 'item_label',
              'summary', 'group', 'multiple'}
SECTION_KEYS = {'id', 'title', 'help', 'show_if', 'fields'}


class ConfigError(Exception):
    def __init__(self, errors):
        super().__init__('\n'.join(errors))
        self.errors = errors


def load_form_config(path):
    text = path.read_text('utf-8')
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ConfigError([f'{path.name} is not valid YAML: {exc}'])
    return normalize(raw, hashlib.sha256(text.encode()).hexdigest()[:12])


def is_filled(value):
    return not (value is None or value == '' or value == [])


def evaluate(cond, values):
    """True when `cond` holds for `values` (a dict of field id -> value)."""
    if cond is None:
        return True
    if 'all' in cond:
        return all(evaluate(c, values) for c in cond['all'])
    if 'any' in cond:
        return any(evaluate(c, values) for c in cond['any'])
    if 'not' in cond:
        return not evaluate(cond['not'], values)
    value = values.get(cond['field'])
    if 'filled' in cond:
        return is_filled(value) == cond['filled']
    targets = [cond['is']] if 'is' in cond else cond['in']
    if isinstance(value, list):
        return any(t in value for t in targets)
    return value in targets


def walk(config, values):
    """Yield (section, field, visible, holder, item_index) for every field, items included.

    `holder` is the dict the field's value lives in: `values` for top-level
    fields, the item dict for fields inside a group item.
    """
    for section in config['sections']:
        section_visible = evaluate(section['show_if'], values)
        for field in section['fields']:
            visible = section_visible and evaluate(field['show_if'], values)
            yield section, field, visible, values, None
            if field['type'] != 'group':
                continue
            for index, item in enumerate(values.get(field['id']) or []):
                scope = {**values, **item}
                for sub in field['fields']:
                    sub_visible = visible and evaluate(sub['show_if'], scope)
                    yield section, sub, sub_visible, item, (field, index)


class _Normalizer:
    def __init__(self, raw):
        self.raw = raw
        self.errors = []
        self.named = raw.get('conditions') or {}
        self.top_fields = {}      # id -> raw field, top level only
        self.group_fields = {}    # group id -> {sub id -> raw field}

    def err(self, msg):
        self.errors.append(msg)

    def index_fields(self):
        for s, section in enumerate(self.raw.get('sections') or []):
            for f, field in enumerate((section or {}).get('fields') or []):
                fid = (field or {}).get('id')
                if not isinstance(fid, str):
                    continue
                if fid in self.top_fields:
                    self.err(f'field id {fid!r} is used twice')
                self.top_fields[fid] = field
                if field.get('type') == 'group':
                    subs = {}
                    for sub in field.get('fields') or []:
                        sid = (sub or {}).get('id')
                        if isinstance(sid, str):
                            if sid in subs:
                                self.err(f'{fid}: field id {sid!r} is used twice in the group')
                            subs[sid] = sub
                    self.group_fields[fid] = subs
        for gid, subs in self.group_fields.items():
            for sid in subs:
                if sid in self.top_fields:
                    self.err(f'{gid}.{sid}: group field ids must differ from top-level ids ({sid!r})')

    def allowed_values(self, field):
        values = list(field.get('options') or [])
        if field.get('other'):
            values.append(OTHER)
        missing = field.get('missing')
        values += self.raw.get('missing_default') or [] if missing is None else missing
        return values

    def cond(self, cond, where, scope, stack=()):
        """Validate a condition and inline named conditions. `scope` maps visible field ids to fields."""
        if cond is None:
            return None
        if isinstance(cond, str):
            if cond not in self.named:
                self.err(f'{where}: unknown condition {cond!r}')
                return None
            if cond in stack:
                self.err(f'{where}: condition {cond!r} refers to itself')
                return None
            return self.cond(self.named[cond], f'{where} → {cond}', scope, stack + (cond,))
        if not isinstance(cond, dict):
            self.err(f'{where}: a condition must be a mapping or a condition name')
            return None
        for key in ('all', 'any'):
            if key in cond:
                if set(cond) != {key} or not isinstance(cond[key], list):
                    self.err(f'{where}: "{key}" takes a list and nothing else')
                    return None
                return {key: [self.cond(c, where, scope, stack) for c in cond[key]]}
        if 'not' in cond:
            if set(cond) != {'not'}:
                self.err(f'{where}: "not" takes one condition and nothing else')
                return None
            return {'not': self.cond(cond['not'], where, scope, stack)}
        fid = cond.get('field')
        tests = [k for k in ('is', 'in', 'filled') if k in cond]
        if fid not in scope:
            self.err(f'{where}: condition refers to unknown field {fid!r}')
            return None
        if len(tests) != 1 or set(cond) != {'field', tests[0]}:
            self.err(f'{where}: use exactly one of is / in / filled with "field"')
            return None
        test = tests[0]
        if test == 'filled':
            return {'field': fid, 'filled': bool(cond['filled'])}
        targets = [cond['is']] if test == 'is' else cond['in']
        if not isinstance(targets, list):
            self.err(f'{where}: "in" takes a list')
            return None
        field = scope[fid]
        if field.get('type') in CHOICE_TYPES:
            allowed = self.allowed_values(field)
            for t in targets:
                if t not in allowed:
                    self.err(f'{where}: {t!r} is not an option of {fid!r}')
        return dict(cond)

    def field(self, field, where, scope, in_group=False):
        if not isinstance(field, dict):
            self.err(f'{where}: a field must be a mapping')
            return None
        fid = field.get('id')
        where = f'{where} ({fid})'
        if not isinstance(fid, str) or not ID_RE.match(fid):
            self.err(f'{where}: id must be lower_snake_case')
        for key in set(field) - FIELD_KEYS:
            self.err(f'{where}: unknown key {key!r}')
        ftype = field.get('type')
        if ftype not in FIELD_TYPES:
            self.err(f'{where}: type must be one of {sorted(FIELD_TYPES)}')
            return None
        if in_group and ftype == 'group':
            self.err(f'{where}: groups cannot be nested')
            return None
        out = {
            'id': fid, 'label': str(field.get('label') or fid), 'type': ftype,
            'help': str(field.get('help') or '').strip(),
            'show_if': self.cond(field.get('show_if'), where, scope),
            'required': field.get('required', False),
        }
        if isinstance(out['required'], (str, dict)):
            out['required'] = self.cond(out['required'], f'{where} required', scope)
        elif not isinstance(out['required'], bool):
            self.err(f'{where}: required must be true, false or a condition')

        if ftype in CHOICE_TYPES:
            options = field.get('options')
            if not isinstance(options, list) or not options or not all(isinstance(o, str) for o in options):
                self.err(f'{where}: options must be a non-empty list of text')
                options = []
            if len(set(options)) != len(options):
                self.err(f'{where}: duplicate options')
            if OTHER in options:
                self.err(f'{where}: use "other: true" instead of listing {OTHER!r}')
            if ftype == 'multiselect':
                for o in options:
                    if ';' in o:
                        self.err(f'{where}: option {o!r} contains ";", which separates values in the CSV')
            out['options'] = options + ([OTHER] if field.get('other') else [])
            out['other'] = bool(field.get('other'))
            if out['other'] and f'{fid}_other' in scope:
                self.err(f'{where}: {fid}_other is reserved for the Other text')
        if ftype in {'select', 'multiselect', 'text', 'textarea', 'number'}:
            missing = field.get('missing')
            out['missing'] = list(self.raw.get('missing_default') or []) if missing is None else missing
            if not isinstance(out['missing'], list):
                self.err(f'{where}: missing must be a list')
                out['missing'] = []
            clash = set(out['missing']) & set(out.get('options') or [])
            if clash:
                self.err(f'{where}: {sorted(clash)} appear in both options and missing; set missing: [] or drop them')
        if ftype in {'text', 'textarea'}:
            out['placeholder'] = str(field.get('placeholder') or '')
            out['evidence'] = bool(field.get('evidence'))
            out['quote'] = bool(field.get('quote'))
        if ftype == 'ref':
            group = field.get('group')
            if group not in self.group_fields:
                self.err(f'{where}: ref group {group!r} is not a group field')
            out['group'] = group
            out['multiple'] = bool(field.get('multiple'))
        if ftype == 'group':
            subs = self.group_fields.get(fid, {})
            sub_scope = {**scope, **subs}
            out['prefix'] = str(field.get('prefix') or fid[:1].upper())
            out['item_label'] = str(field.get('item_label') or 'item')
            out['fields'] = [f for f in (self.field(s, f'{where}.fields[{i}]', sub_scope, in_group=True)
                                         for i, s in enumerate(field.get('fields') or [])) if f]
            if not out['fields']:
                self.err(f'{where}: a group needs fields')
            summary = field.get('summary') or []
            for sid in summary:
                if sid not in subs:
                    self.err(f'{where}: summary field {sid!r} is not in the group')
            out['summary'] = summary
        return out

    def run(self):
        raw = self.raw
        if not isinstance(raw.get('sections'), list) or not raw['sections']:
            self.err('the config needs a non-empty "sections" list')
            return None
        if not isinstance(self.named, dict):
            self.err('"conditions" must be a mapping of name -> condition')
            self.named = {}
        self.index_fields()
        sections, section_ids = [], set()
        for s, section in enumerate(raw['sections']):
            if not isinstance(section, dict):
                self.err(f'sections[{s}]: a section must be a mapping')
                continue
            sid = section.get('id')
            where = f'sections[{s}] ({sid})'
            if not isinstance(sid, str) or not ID_RE.match(sid):
                self.err(f'{where}: id must be lower_snake_case')
            if sid in section_ids:
                self.err(f'{where}: section id used twice')
            section_ids.add(sid)
            for key in set(section) - SECTION_KEYS:
                self.err(f'{where}: unknown key {key!r}')
            fields = [f for f in (self.field(f, f'{where}.fields[{i}]', self.top_fields)
                                  for i, f in enumerate(section.get('fields') or [])) if f]
            sections.append({
                'id': sid, 'title': str(section.get('title') or sid),
                'help': str(section.get('help') or '').strip(),
                'show_if': self.cond(section.get('show_if'), where, self.top_fields),
                'fields': fields,
            })
        return sections


def normalize(raw, source_hash=''):
    if not isinstance(raw, dict):
        raise ConfigError(['the config must be a YAML mapping'])
    norm = _Normalizer(raw)
    sections = norm.run()
    if norm.errors:
        raise ConfigError(norm.errors)
    return {
        'version': str(raw.get('version', '')),
        'hash': source_hash,
        'title': str(raw.get('title') or 'Extraction form'),
        'sections': sections,
    }


def groups(config):
    return {f['id']: f for s in config['sections'] for f in s['fields'] if f['type'] == 'group'}


def condition_text(cond):
    """Readable form of a condition, for the codebook."""
    if cond is None:
        return ''
    if 'all' in cond:
        return ' AND '.join(f'({condition_text(c)})' for c in cond['all'])
    if 'any' in cond:
        return ' OR '.join(f'({condition_text(c)})' for c in cond['any'])
    if 'not' in cond:
        return f'NOT ({condition_text(cond["not"])})'
    if 'filled' in cond:
        return f'{cond["field"]} is {"filled" if cond["filled"] else "blank"}'
    if 'is' in cond:
        return f'{cond["field"]} = {cond["is"]}'
    return f'{cond["field"]} in [{"; ".join(map(str, cond["in"]))}]'
