// Mirrors evaluate() and walk() in formconfig.py; keep the two in step.

export function isFilled(value) {
  return !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
}

export function evaluate(cond, values) {
  if (!cond) return true;
  if (cond.all) return cond.all.every((c) => evaluate(c, values));
  if (cond.any) return cond.any.some((c) => evaluate(c, values));
  if (cond.not) return !evaluate(cond.not, values);
  const value = values[cond.field];
  if ('filled' in cond) return isFilled(value) === cond.filled;
  const targets = 'is' in cond ? [cond.is] : cond.in;
  if (Array.isArray(value)) return targets.some((t) => value.includes(t));
  return targets.includes(value);
}

// Yields {section, field, visible, holder, group, index} for every field,
// including the fields of each group item (holder is then the item).
export function* walk(config, values) {
  for (const section of config.sections) {
    const sectionVisible = evaluate(section.show_if, values);
    for (const field of section.fields) {
      const visible = sectionVisible && evaluate(field.show_if, values);
      yield { section, field, visible, holder: values, group: null, index: null };
      if (field.type !== 'group') continue;
      const items = values[field.id] || [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const scope = { ...values, ...item };
        for (const sub of field.fields) {
          const subVisible = visible && evaluate(sub.show_if, scope);
          yield { section, field: sub, visible: subVisible, holder: item, group: field, index };
        }
      }
    }
  }
}

export function isRequired(field, holder, values) {
  if (field.required === true) return true;
  if (!field.required) return false;
  return evaluate(field.required, holder === values ? values : { ...values, ...holder });
}
