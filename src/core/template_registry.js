import path from 'path';
import { readFile, readdir, stat } from 'fs/promises';
import { RenderError } from './errors.js';
import { parse_manifest, infer_manifest } from './template_manifest.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Resolves template names to manifests + HTML, checking the user directory
 * before the builtin one. See docs/specification.md §5.4.
 */
export default class TemplateRegistry {
  constructor({ builtin_dir = null, user_dir = null, cache_ttl_ms = 5000 } = {}) {
    this.builtin_dir  = builtin_dir;
    this.user_dir     = user_dir;
    this.cache_ttl_ms = cache_ttl_ms;
    this._cache       = new Map(); // name -> { resolved, cached_at }
  }

  /**
   * @returns {Promise<Array<Object>>} Template summaries, broken dirs skipped.
   */
  async list({ tag, kind } = {}) {
    const names = new Set();

    for (const dir of [this.user_dir, this.builtin_dir]) {
      for (const name of await this._list_dir(dir)) names.add(name);
    }

    const summaries = [];

    for (const name of names) {
      let resolved;

      try {
        resolved = await this.resolve(name);
      } catch {
        continue; // skip templates that fail to parse rather than failing list()
      }

      const { manifest, source } = resolved;

      if (tag && !manifest.tags.includes(tag)) continue;
      if (kind && manifest.kind !== 'both' && manifest.kind !== kind) continue;

      summaries.push({
        name:           manifest.name,
        title:          manifest.title,
        kind:           manifest.kind,
        source,
        default_format: manifest.default_format,
        vars_count:     manifest.vars.length,
        network:        manifest.network,
        inferred:       manifest.inferred,
      });
    }

    return summaries;
  }

  async get(name) {
    return (await this.resolve(name)).manifest;
  }

  /**
   * @returns {Promise<{ manifest: Object, html_path: string, base_dir: string, source: 'user'|'builtin' }>}
   */
  async resolve(name) {
    this._validate_name(name);

    const cached = this._cache.get(name);
    if (cached && Date.now() - cached.cached_at < this.cache_ttl_ms) {
      return cached.resolved;
    }

    const hit = await this._find_dir(name);

    if (!hit) {
      throw new RenderError('TEMPLATE_NOT_FOUND', `Template "${name}" was not found`, { template: name });
    }

    const manifest = await this._load_manifest(hit.dir, name);
    const resolved = {
      manifest,
      html_path: path.join(hit.dir, manifest.entry),
      base_dir:  hit.dir,
      source:    hit.source,
    };

    this._cache.set(name, { resolved, cached_at: Date.now() });

    return resolved;
  }

  async read_html(name) {
    const { html_path } = await this.resolve(name);
    return readFile(html_path, 'utf-8');
  }

  async reload() {
    this._cache.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _validate_name(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new RenderError('INVALID_REQUEST', `Invalid template name "${name}"`, { template: name });
    }
  }

  async _find_dir(name) {
    if (this.user_dir) {
      const user_path = path.join(this.user_dir, name);
      if (await this._is_dir(user_path)) return { dir: user_path, source: 'user' };
    }

    if (this.builtin_dir) {
      const builtin_path = path.join(this.builtin_dir, name);
      if (await this._is_dir(builtin_path)) return { dir: builtin_path, source: 'builtin' };
    }

    return null;
  }

  async _load_manifest(dir, name) {
    try {
      const raw = await readFile(path.join(dir, 'template.json'), 'utf-8');
      return parse_manifest(raw, name);
    } catch (error) {
      if (error instanceof RenderError) throw error;

      // No template.json — infer a manifest from the HTML entry file.
      const entry = await this._find_entry_html(dir, name);
      const html  = await readFile(path.join(dir, entry), 'utf-8');

      return infer_manifest(html, name, entry);
    }
  }

  async _find_entry_html(dir, name) {
    const files = await readdir(dir);

    if (files.includes('template.html')) return 'template.html';

    const html_files = files.filter(file => file.endsWith('.html'));
    if (html_files.length === 1) return html_files[0];

    throw new RenderError('TEMPLATE_INVALID', `Cannot infer an entry HTML file for template "${name}"`, { template: name });
  }

  async _list_dir(dir) {
    if (!dir) return [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  }

  async _is_dir(candidate) {
    try {
      return (await stat(candidate)).isDirectory();
    } catch {
      return false;
    }
  }
}
