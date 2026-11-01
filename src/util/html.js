// Tiny tagged-template HTML with auto-escaping.
// html`<p>${userText}</p>` escapes userText. Nest with html`` or raw().

const RAW = Symbol('raw');

export function raw(str) {
  return { [RAW]: true, value: String(str ?? '') };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'object' && value[RAW]) return value.value;
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

export function toString(fragment) {
  return render(fragment);
}

// JSON safe to embed inside <script> tags.
export function jsonForScript(value) {
  return raw(JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}
