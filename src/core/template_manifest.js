import { RenderError } from './errors.js';

// ─── Template manifest parsing / inference / var validation ─────────────────
// See docs/specification.md §9.2–9.3.

const VALID_VAR_TYPES = ['string', 'number', 'boolean', 'color', 'url', 'html'];

// Matches {{KEY}} and {{{KEY}}} alike, capturing KEY either way.
const PLACEHOLDER_PATTERN = /\{\{\{?(\w+)\}?\}\}/g;

/**
 * Parse a template.json manifest. Throws RenderError('TEMPLATE_INVALID') on
 * malformed JSON or a missing required field.
 *
 * @param {string} raw_json
 * @param {string} dir_name  Directory name, used as a name fallback.
 */
export function parse_manifest(raw_json, dir_name) {
  let data;

  try {
    data = JSON.parse(raw_json);
  } catch (error) {
    throw new RenderError('TEMPLATE_INVALID', `template.json is not valid JSON: ${error.message}`, { dir: dir_name });
  }

  if (!data.entry) {
    throw new RenderError('TEMPLATE_INVALID', 'template.json is missing required field "entry"', { dir: dir_name });
  }

  return {
    name:              data.name ?? dir_name,
    title:             data.title ?? data.name ?? dir_name,
    description:       data.description ?? '',
    version:           data.version ?? '1.0.0',
    entry:             data.entry,
    kind:              data.kind ?? 'both',
    network:           data.network ?? 'optional',
    default_format:    data.default_format ?? null,
    supported_formats: Array.isArray(data.supported_formats) ? data.supported_formats : [],
    video:             data.video ?? null,
    vars:              Array.isArray(data.vars) ? data.vars : [],
    tags:              Array.isArray(data.tags) ? data.tags : [],
    inferred:          false,
  };
}

/**
 * Build a manifest by scanning HTML for {{KEY}} placeholders when no
 * template.json is present. All inferred vars are optional strings.
 *
 * @param {string} html
 * @param {string} dir_name
 * @param {string} [entry]  Entry HTML filename actually used, for the manifest.
 */
export function infer_manifest(html, dir_name, entry = 'template.html') {
  const keys = new Set();
  let match;

  PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = PLACEHOLDER_PATTERN.exec(html)) !== null) {
    keys.add(match[1]);
  }

  return {
    name:              dir_name,
    title:             dir_name,
    description:       '',
    version:           '1.0.0',
    entry,
    kind:              'both',
    network:           'optional',
    default_format:    null,
    supported_formats: [],
    video:             null,
    vars:              [...keys].map(name => ({ name, type: 'string', required: false })),
    tags:              [],
    inferred:          true,
  };
}

/**
 * Apply manifest defaults, enforce required vars, and flag soft issues
 * (unknown declared types, values exceeding max_length) without failing the
 * whole request for those. Missing required vars throw MISSING_REQUIRED_VAR.
 * Vars not declared in the manifest are passed through unchanged.
 *
 * @param {Object} manifest
 * @param {Object} [vars]
 * @returns {{ values: Object, errors: Array<Object> }}
 */
export function validate_vars(manifest, vars = {}) {
  const values = { ...vars };
  const errors = [];

  for (const spec of manifest.vars ?? []) {
    const has_value = values[spec.name] !== undefined && values[spec.name] !== null && values[spec.name] !== '';

    if (!has_value) {
      if (spec.default !== undefined) {
        values[spec.name] = spec.default;
        continue;
      }

      if (spec.required) {
        throw new RenderError('MISSING_REQUIRED_VAR', `Template "${manifest.name}" requires var "${spec.name}"`, {
          template: manifest.name,
          var:      spec.name,
        });
      }

      continue;
    }

    if (spec.type && !VALID_VAR_TYPES.includes(spec.type)) {
      errors.push({ var: spec.name, reason: 'unknown_type', type: spec.type });
      continue;
    }

    if (spec.max_length && String(values[spec.name]).length > spec.max_length) {
      errors.push({ var: spec.name, reason: 'max_length_exceeded', max_length: spec.max_length });
    }
  }

  return { values, errors };
}
