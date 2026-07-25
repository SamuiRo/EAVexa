// ─── HTML template helpers ───────────────────────────────────────────────────

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for safe insertion into HTML text or attribute content.
 */
export function escape_html(value) {
  return String(value).replace(/[&<>"']/g, char => ESCAPE_MAP[char]);
}

/**
 * Replace placeholders in HTML with values from vars.
 * `{{KEY}}` is escaped; `{{{KEY}}}` inserts raw HTML — a deliberate opt-in.
 *
 * @param {string} html
 * @param {Object} vars
 * @returns {string}
 */
export function apply_vars(html, vars) {
  let result = html;

  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{{${key}}}}`, String(value));
  }

  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, escape_html(value));
  }

  return result;
}

/**
 * Inject a <base href> tag so relative asset paths (fonts, images) resolve
 * against base_url. No-op if the template already declares its own <base>.
 */
export function inject_base_url(html, base_url) {
  if (/<base\s/i.test(html)) {
    return html;
  }

  const tag = `<base href="${escape_html(base_url)}">`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
  }

  return `${tag}\n${html}`;
}

/**
 * Inject <link rel="preload"> tags for font stylesheets into <head>.
 */
export function inject_font_preloads(html, font_urls) {
  const tags = font_urls
    .map(url => `<link rel="preload" href="${escape_html(url)}" as="style" onload="this.rel='stylesheet'">`)
    .join('\n  ');

  return html.replace('</head>', `  ${tags}\n</head>`);
}
