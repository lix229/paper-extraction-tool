// node --test tests/js/*.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluate, isRequired, walk } from '../../static/conditions.js';

const cases = JSON.parse(readFileSync(new URL('../condition_cases.json', import.meta.url)));

test('evaluate matches the shared cases', () => {
  for (const c of cases) assert.equal(evaluate(c.cond, c.values), c.expect, JSON.stringify(c));
});

test('walk yields group item fields with item scope', () => {
  const config = {
    sections: [{
      id: 's', show_if: null, fields: [
        { id: 'kind', type: 'select', show_if: null },
        { id: 'items', type: 'group', show_if: { field: 'kind', is: 'yes' }, fields: [
          { id: 'country', type: 'select', show_if: null },
          { id: 'evidence', type: 'text', show_if: { field: 'country', in: ['UK', 'US'] } },
        ] },
      ],
    }],
  };
  const values = { kind: 'yes', items: [{ _id: 'a', country: 'UK' }, { _id: 'b', country: 'Not reported' }] };
  const seen = [...walk(config, values)].map((e) => `${e.group ? `${e.group.id}${e.index}.` : ''}${e.field.id}:${e.visible}`);
  assert.deepEqual(seen, ['kind:true', 'items:true', 'items0.country:true', 'items0.evidence:true', 'items1.country:true', 'items1.evidence:false']);

  values.kind = 'no';
  assert.ok([...walk(config, values)].filter((e) => e.group).every((e) => !e.visible));
});

test('isRequired evaluates conditions against the item', () => {
  const field = { required: { field: 'country', in: ['UK'] } };
  assert.equal(isRequired(field, { country: 'UK' }, {}), true);
  assert.equal(isRequired(field, { country: 'US' }, {}), false);
  assert.equal(isRequired({ required: true }, {}, {}), true);
  assert.equal(isRequired({ required: false }, {}, {}), false);
});
