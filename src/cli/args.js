// ─── Dependency-free CLI argument parser ─────────────────────────────────────
// See docs/specification.md §11.1. Handles `--flag value`, `--flag=value`,
// boolean flags, short aliases, and repeated flags (collected into an array).

/**
 * @param {string[]} argv
 * @param {{ aliases?: Object<string,string>, booleans?: string[] }} [opts]
 * @returns {{ _: string[], [key: string]: * }}
 */
export function parse_args(argv, { aliases = {}, booleans = [] } = {}) {
  const result = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      result._.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      i = consume_flag(token.slice(2), argv, i, result, aliases, booleans);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      i = consume_flag(token.slice(1), argv, i, result, aliases, booleans);
      continue;
    }

    result._.push(token);
  }

  return result;
}

function consume_flag(body, argv, i, result, aliases, booleans) {
  const [raw_key, ...rest] = body.split('=');
  const key = aliases[raw_key] ?? raw_key;
  let value = rest.length ? rest.join('=') : undefined;
  let next_i = i;

  if (value === undefined) {
    if (booleans.includes(key) || looks_like_next_flag(argv[i + 1])) {
      value = true;
    } else {
      value = argv[i + 1];
      next_i = i + 1;
    }
  }

  assign(result, key, value);
  return next_i;
}

function looks_like_next_flag(token) {
  return token === undefined || (token.startsWith('-') && token.length > 1 && Number.isNaN(Number(token)));
}

function assign(result, key, value) {
  if (key in result) {
    result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
  } else {
    result[key] = value;
  }
}

/**
 * Normalize a parsed flag that may be absent, a single value, or an array
 * (when repeated) into an array. Useful for `--var K=V` style flags.
 */
export function as_array(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
