"""CSV export: one row per paper, plus a codebook describing every column.

Repeatable groups become numbered columns (findings_1_type, findings_2_type, …)
sized to the paper with the most items. Hidden fields export blank even when
they keep a value; `hidden_values` lists them. Multi-select values are joined
with "; ".
"""
import csv
import io
import re

from formconfig import OTHER, condition_text, evaluate, groups, is_filled, walk

NUMBER_RE = re.compile(r'^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$')
BOM = '﻿'  # lets Excel detect UTF-8


def _text(value):
    if value is None:
        return ''
    if isinstance(value, list):
        return '; '.join(_text(v) for v in value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _cell(text):
    """Stop Excel from running cell text as a formula (e.g. a quotation starting with '=')."""
    if text and text[0] in '=+-@\t\r' and not NUMBER_RE.match(text):
        return "'" + text
    return text


def _item_codes(config, values):
    """Map item _id -> code such as 'C2' for every group item in `values`."""
    codes = {}
    for gid, group in groups(config).items():
        for i, item in enumerate(values.get(gid) or []):
            codes[item.get('_id')] = f'{group["prefix"]}{i + 1}'
    return codes


def _field_value(field, holder, codes):
    value = holder.get(field['id'])
    if field['type'] == 'ref':
        ids = value if isinstance(value, list) else [value] if value else []
        return '; '.join(codes.get(i, '?') for i in ids)
    return _text(value)


def _other_value(field, holder):
    value = holder.get(field['id'])
    chosen = OTHER in value if isinstance(value, list) else value == OTHER
    return _text(holder.get(field['id'] + '_other')) if chosen else ''


def field_columns(config, group_sizes):
    """Column names for the extraction fields, in form order."""
    cols = []
    for section in config['sections']:
        for field in section['fields']:
            if field['type'] == 'group':
                cols.append(f'{field["id"]}_count')
                for n in range(1, group_sizes.get(field['id'], 0) + 1):
                    for sub in field['fields']:
                        cols.append(f'{field["id"]}_{n}_{sub["id"]}')
                        if sub.get('other'):
                            cols.append(f'{field["id"]}_{n}_{sub["id"]}_other')
            else:
                cols.append(field['id'])
                if field.get('other'):
                    cols.append(field['id'] + '_other')
    return cols


def extraction_cells(config, values):
    """Column -> text for one record; hidden fields are left out (exported blank)."""
    codes = _item_codes(config, values)
    cells = {}
    for section, field, visible, holder, item in walk(config, values):
        if field['type'] == 'group':
            if visible:
                cells[f'{field["id"]}_count'] = str(len(values.get(field['id']) or []))
            continue
        if not visible:
            continue
        name = field['id'] if item is None else f'{item[0]["id"]}_{item[1] + 1}_{field["id"]}'
        cells[name] = _field_value(field, holder, codes)
        if field.get('other'):
            cells[name + '_other'] = _other_value(field, holder)
    return cells


def hidden_values(config, values):
    """Ids of hidden fields that still hold a value (kept in the record, not exported)."""
    hidden, hidden_groups = [], set()
    for section, field, visible, holder, item in walk(config, values):
        if visible or not is_filled(holder.get(field['id'])):
            continue
        if item is not None and item[0]['id'] in hidden_groups:
            continue  # the whole group is already listed
        if field['type'] == 'group':
            hidden_groups.add(field['id'])
        hidden.append(field['id'] if item is None else f'{item[0]["id"]}_{item[1] + 1}_{field["id"]}')
    return hidden


def export_csv(config, papers, records, matches, pdfs, screening_columns):
    """`records`, `matches` and `pdfs` map record_id -> stored dict (or None)."""
    group_ids = list(groups(config))
    sizes = {g: max([len((r or {}).get('values', {}).get(g) or []) for r in records.values()] + [1])
             for g in group_ids}
    base = (['record_id', 'title', 'authors', 'year', 'source_kind', 'doi', 'source_link']
            + [f'screening_{c}' for c in screening_columns]
            + ['s2_paper_id', 's2_match_method', 's2_match_confirmed',
               'pdf_origin', 'pdf_oa_status', 'pdf_url', 'pdf_sha256',
               'reviewer', 'status', 'created_at', 'updated_at', 'config_version', 'config_hash',
               'applicable_sections', 'hidden_values'])
    columns = base + field_columns(config, sizes)

    out = io.StringIO()
    out.write(BOM)
    writer = csv.DictWriter(out, fieldnames=columns, lineterminator='\r\n')
    writer.writeheader()
    for paper in papers:
        rid = paper['record_id']
        record = records.get(rid) or {}
        match = matches.get(rid) or {}
        pdf = pdfs.get(rid) or {}
        s2 = match.get('paper') or {}
        values = record.get('values') or {}
        row = {
            'record_id': rid, 'title': paper['title'], 'authors': paper['authors'], 'year': paper['year'],
            'source_kind': paper['source']['kind'], 'doi': paper['source'].get('doi', ''),
            'source_link': paper['source'].get('url') or '',
            **{f'screening_{c}': paper['screening'].get(c, '') for c in screening_columns},
            's2_paper_id': s2.get('paperId', ''),
            's2_match_method': match.get('method', match.get('status', '')),
            's2_match_confirmed': {True: 'yes', False: 'no'}.get(match.get('confirmed'), '') if match else '',
            'pdf_origin': pdf.get('origin', ''),
            'pdf_oa_status': (s2.get('openAccessPdf') or {}).get('status') or '' if pdf.get('origin') == 'semantic_scholar' else '',
            'pdf_url': pdf.get('final_url') or pdf.get('url') or '',
            'pdf_sha256': pdf.get('sha256', ''),
            'reviewer': record.get('reviewer', ''),
            'status': record.get('status', 'Not started'),
            'created_at': record.get('created_at', ''),
            'updated_at': record.get('updated_at', ''),
            'config_version': record.get('config_version', ''),
            'config_hash': record.get('config_hash', ''),
            'applicable_sections': '; '.join(s['id'] for s in config['sections'] if evaluate(s['show_if'], values)) if record else '',
            'hidden_values': '; '.join(hidden_values(config, values)),
        }
        row.update(extraction_cells(config, values))
        writer.writerow({k: _cell(_text(v)) for k, v in row.items()})
    return out.getvalue()


def codebook_csv(config):
    out = io.StringIO()
    out.write(BOM)
    writer = csv.writer(out, lineterminator='\r\n')
    writer.writerow(['column', 'section', 'label', 'type', 'options', 'missing_values', 'shown_when', 'required', 'help'])
    for section in config['sections']:
        for field in section['fields']:
            subs = [(f'{field["id"]}_N_{s["id"]}', s, field) for s in field['fields']] if field['type'] == 'group' else []
            rows = [(f'{field["id"]}_count' if subs else field['id'], field, None)] + subs
            for column, f, parent in rows:
                shown = [c for c in (section['show_if'], field['show_if'] if parent else None, f['show_if']) if c]
                ftype = 'count of items' if f['type'] == 'group' else f['type']
                if f['type'] == 'ref':
                    ftype = f'item codes from {f["group"]}'
                required = f['required'] if isinstance(f['required'], bool) else condition_text(f['required'])
                writer.writerow([
                    column, section['title'], f['label'], ftype, '; '.join(f.get('options') or []),
                    '; '.join(f.get('missing') or []), ' AND '.join(f'({condition_text(c)})' for c in shown),
                    {True: 'yes', False: ''}.get(required, required), f['help'],
                ])
                if f.get('other'):
                    writer.writerow([column + '_other', section['title'], f'{f["label"]}: Other (specify)', 'text',
                                     '', '', f'{column} includes Other', '', ''])
    return out.getvalue()
