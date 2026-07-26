// ─── Minimal method + path router ────────────────────────────────────────────
// No dependencies. Supports `:param` path segments. See docs/specification.md §4.

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');

  return { regex: new RegExp(`^${source}$`), keys };
}

export default class Router {
  constructor() {
    this._routes = [];
  }

  add(method, pattern, handler) {
    const { regex, keys } = compile(pattern);
    this._routes.push({ method: method.toUpperCase(), regex, keys, handler });
    return this;
  }

  get(pattern, handler)    { return this.add('GET', pattern, handler); }
  post(pattern, handler)   { return this.add('POST', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{ handler: Function, params: Object } | null}
   */
  match(method, pathname) {
    const upper = method.toUpperCase();
    let path_matched = false;

    for (const route of this._routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;

      path_matched = true;
      if (route.method !== upper) continue;

      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });

      return { handler: route.handler, params };
    }

    return path_matched ? { method_not_allowed: true } : null;
  }
}
