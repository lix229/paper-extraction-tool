import csv
import io

from export import codebook_csv, export_csv
from formconfig import normalize

RAW = {
    'missing_default': ['Not reported'],
    'conditions': {'included': {'field': 'decision', 'is': 'Include'}},
    'sections': [
        {'id': 'elig', 'fields': [
            {'id': 'decision', 'type': 'select', 'options': ['Include', 'Exclude'], 'missing': []},
            {'id': 'reason', 'type': 'select', 'options': ['Duplicate'], 'other': True,
             'show_if': {'field': 'decision', 'is': 'Exclude'}},
        ]},
        {'id': 'main', 'show_if': 'included', 'fields': [
            {'id': 'users', 'type': 'multiselect', 'options': ['Clinicians', 'Patients'], 'other': True},
            {'id': 'size', 'type': 'number'},
            {'id': 'quote', 'type': 'textarea'},
            {'id': 'contexts', 'type': 'group', 'prefix': 'C', 'fields': [
                {'id': 'country', 'type': 'select', 'options': ['UK', 'US']},
            ]},
            {'id': 'findings', 'type': 'group', 'prefix': 'F', 'fields': [
                {'id': 'ctx', 'type': 'ref', 'group': 'contexts'},
                {'id': 'text', 'type': 'textarea'},
            ]},
        ]},
    ],
}
PAPERS = [
    {'record_id': 'R1', 'title': 'One', 'authors': 'A', 'year': '2024', 'abstract': '',
     'source': {'kind': 'doi', 'doi': '10.1/x', 'url': 'https://doi.org/10.1/x'}},
    {'record_id': 'R2', 'title': '=Formula title', 'authors': 'B', 'year': '2025', 'abstract': '',
     'source': {'kind': 'missing', 'url': None}},
    {'record_id': 'R3', 'title': 'Untouched', 'authors': 'C', 'year': '2023', 'abstract': '',
     'source': {'kind': 'pmid', 'url': 'https://pubmed.ncbi.nlm.nih.gov/1/'}},
]


def rows(text):
    assert text.startswith('﻿')
    return list(csv.DictReader(io.StringIO(text[1:])))


def build(records):
    config = normalize(RAW)
    return rows(export_csv(config, PAPERS, records, {}))


def test_one_row_per_paper_with_numbered_group_columns():
    records = {
        'R1': {'status': 'In progress', 'rev': 1, 'values': {
            'decision': 'Include', 'users': ['Clinicians', 'Other'], 'users_other': 'Pharmacists', 'size': 120.0,
            'contexts': [{'_id': 'c1', 'country': 'UK'}, {'_id': 'c2', 'country': 'US'}],
            'findings': [{'_id': 'f1', 'ctx': 'c2', 'text': 'AUROC 0.91'}],
            'reason': 'Duplicate',  # hidden: decision is Include
        }},
        'R2': {'status': 'Complete', 'rev': 3, 'values': {'decision': 'Exclude', 'reason': 'Other', 'reason_other': 'Erratum',
                                                         'quote': '-not a number', 'users': 'Not reported'}},
    }
    out = build(records)
    assert [r['record_id'] for r in out] == ['R1', 'R2', 'R3']
    r1, r2, r3 = out
    assert r1['users'] == 'Clinicians; Other' and r1['users_other'] == 'Pharmacists'
    assert r1['size'] == '120'
    assert r1['contexts_count'] == '2' and r1['contexts_1_country'] == 'UK' and r1['contexts_2_country'] == 'US'
    assert r1['findings_1_ctx'] == 'C2' and r1['findings_1_text'] == 'AUROC 0.91'
    assert r1['reason'] == '' and r1['hidden_values'] == 'reason'
    assert r1['applicable_sections'] == 'elig; main'
    # excluded paper: substantive fields hidden, reason shown with Other text
    assert r2['reason'] == 'Other' and r2['reason_other'] == 'Erratum'
    assert r2['users'] == '' and r2['contexts_count'] == ''
    assert set(r2['hidden_values'].split('; ')) == {'users', 'quote'}
    # spreadsheet formula guard
    assert r2['title'] == "'=Formula title"
    # paper without a record
    assert r3['status'] == 'Not started' and r3['decision'] == '' and r3['source_link'].startswith('https://pubmed')


def test_group_columns_sized_to_largest_and_at_least_one():
    out = build({})
    assert 'contexts_1_country' in out[0] and 'contexts_2_country' not in out[0]


def test_numbers_are_not_escaped():
    raw = {'sections': [{'id': 's', 'fields': [{'id': 'n', 'type': 'number'}, {'id': 't', 'type': 'text'}]}]}
    config = normalize(raw)
    text = export_csv(config, PAPERS[:1], {'R1': {'values': {'n': -3.5, 't': '+44 20'}}}, {})
    row = rows(text)[0]
    assert row['n'] == '-3.5' and row['t'] == "'+44 20"


def test_codebook_lists_every_column():
    config = normalize(RAW)
    book = rows(codebook_csv(config))
    columns = [r['column'] for r in book]
    assert columns == ['decision', 'reason', 'reason_other', 'users', 'users_other', 'size', 'quote',
                       'contexts_count', 'contexts_N_country', 'findings_count', 'findings_N_ctx', 'findings_N_text']
    reason = next(r for r in book if r['column'] == 'reason')
    assert reason['shown_when'] == '(decision = Exclude)'
