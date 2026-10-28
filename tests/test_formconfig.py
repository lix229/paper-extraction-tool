import json
from pathlib import Path

import pytest

from formconfig import ConfigError, evaluate, load_form_config, normalize, walk

ROOT = Path(__file__).resolve().parent.parent


def base(**section):
    return {'sections': [{'id': 's', 'fields': [{'id': 'decision', 'type': 'select', 'options': ['Include', 'Exclude']}],
                          **section}]}


def errors_of(raw):
    with pytest.raises(ConfigError) as info:
        normalize(raw)
    return '\n'.join(info.value.errors)


def test_shipped_form_is_valid():
    config = load_form_config(ROOT / 'form.yaml')
    ids = [f['id'] for s in config['sections'] for f in s['fields']]
    assert 'decision' in ids and 'findings' in ids
    findings = next(f for s in config['sections'] for f in s['fields'] if f['id'] == 'findings')
    assert findings['prefix'] == 'F'
    # named conditions are inlined for the browser
    research = next(s for s in config['sections'] if s['id'] == 'research')
    assert 'any' in research['show_if']
    # YAML must not turn Yes/No into booleans
    comparison = next(f for s in config['sections'] for f in s['fields'] if f['id'] == 'uk_us_comparison')
    assert comparison['options'] == ['Yes', 'No']


def test_shared_condition_cases():
    for case in json.loads((ROOT / 'tests' / 'condition_cases.json').read_text()):
        assert evaluate(case['cond'], case['values']) == case['expect'], case


def test_other_and_missing_defaults():
    raw = base()
    raw['missing_default'] = ['Not reported']
    raw['sections'][0]['fields'].append({'id': 'kind', 'type': 'multiselect', 'options': ['A'], 'other': True})
    field = normalize(raw)['sections'][0]['fields'][1]
    assert field['options'] == ['A', 'Other']
    assert field['missing'] == ['Not reported']


def test_unknown_type_and_key():
    raw = base()
    raw['sections'][0]['fields'].append({'id': 'x', 'type': 'radio'})
    raw['sections'][0]['fields'].append({'id': 'y', 'type': 'text', 'colour': 'red'})
    errs = errors_of(raw)
    assert "type must be one of" in errs
    assert "unknown key 'colour'" in errs


def test_condition_checks_field_and_option():
    raw = base()
    raw['sections'][0]['fields'].append({'id': 'reason', 'type': 'text', 'show_if': {'field': 'decison', 'is': 'Exclude'}})
    raw['sections'][0]['fields'].append({'id': 'note', 'type': 'text', 'show_if': {'field': 'decision', 'is': 'Excluded'}})
    errs = errors_of(raw)
    assert "unknown field 'decison'" in errs
    assert "'Excluded' is not an option of 'decision'" in errs


def test_named_condition_cycle():
    raw = base(show_if='a')
    raw['conditions'] = {'a': {'any': ['b']}, 'b': {'all': ['a']}}
    assert 'refers to itself' in errors_of(raw)


def test_duplicate_ids_and_option_clash():
    raw = base()
    raw['sections'][0]['fields'].append({'id': 'decision', 'type': 'text'})
    raw['sections'][0]['fields'].append({'id': 'status', 'type': 'select', 'options': ['Unclear', 'Known'], 'missing': ['Unclear']})
    errs = errors_of(raw)
    assert "'decision' is used twice" in errs
    assert "appear in both options and missing" in errs


def test_multiselect_option_with_semicolon_rejected():
    raw = base()
    raw['sections'][0]['fields'].append({'id': 'm', 'type': 'multiselect', 'options': ['a; b']})
    assert 'separates values in the CSV' in errors_of(raw)


def test_group_fields_and_refs():
    raw = base()
    raw['sections'][0]['fields'] += [
        {'id': 'contexts', 'type': 'group', 'prefix': 'C', 'summary': ['country'], 'fields': [
            {'id': 'country', 'type': 'select', 'options': ['UK', 'US']},
            {'id': 'evidence', 'type': 'text', 'required': {'field': 'country', 'in': ['UK']}},
        ]},
        {'id': 'link', 'type': 'ref', 'group': 'contexts'},
        {'id': 'bad_link', 'type': 'ref', 'group': 'nope'},
    ]
    assert "ref group 'nope' is not a group field" in errors_of(raw)
    raw['sections'][0]['fields'].pop()
    config = normalize(raw)
    values = {'decision': 'Include', 'contexts': [{'_id': 'a', 'country': 'UK'}]}
    entries = [(f['id'], visible, item is not None) for _, f, visible, _, item in walk(config, values)]
    assert ('evidence', True, True) in entries


def test_group_field_cannot_reuse_top_level_id():
    raw = base()
    raw['sections'][0]['fields'].append({'id': 'g', 'type': 'group', 'fields': [{'id': 'decision', 'type': 'text'}]})
    assert 'must differ from top-level ids' in errors_of(raw)
