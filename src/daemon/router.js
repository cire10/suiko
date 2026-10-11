// @ts-check
// A tiny method + path router over pre-decoded path segments (see security.parseTarget).
// Patterns: '/api/docs/:ws/:doc' (a ':name' matches exactly one segment) and '/ui/*' (a trailing '*' matches the
// remaining segments, possibly none, exposed as params['*'] joined with '/' and as `rest`). Static segments
// match exactly. HEAD requests fall back to GET routes. match() distinguishes "no route" (null) from "route exists
// for another method" ({ allowed }) so callers can answer 404 vs 405.

/**
 * @typedef {(ctx: RouteContext) => Promise<void> | void} RouteHandler
 * @typedef {object} RouteContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {Record<string, string>} params
 * @property {string[]} rest segments matched by a trailing '*'
 * @property {URLSearchParams} query
 * @property {import('./security.js').RequestTarget} target
 */

/**
 * @typedef {{ method: string, parts: Array<{ kind: 'static' | 'param', value: string }>, wildcard: boolean, handler: RouteHandler }} Route
 */

export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {RouteHandler} handler
   * @returns {this}
   */
  add(method, pattern, handler) {
    if (!pattern.startsWith('/')) throw new TypeError(`route pattern must start with '/': ${pattern}`);
    const raw = pattern === '/' ? [] : pattern.split('/').slice(1);
    const wildcard = raw[raw.length - 1] === '*';
    if (wildcard) raw.pop();
    const parts = raw.map((seg) => {
      if (seg === '*' || seg === '') throw new TypeError(`invalid route pattern: ${pattern}`);
      return seg.startsWith(':') ? { kind: /** @type {const} */ ('param'), value: seg.slice(1) } : { kind: /** @type {const} */ ('static'), value: seg };
    });
    this.routes.push({ method: method.toUpperCase(), parts, wildcard, handler });
    return this;
  }

  /** @param {string} p @param {RouteHandler} h */
  get(p, h) {
    return this.add('GET', p, h);
  }

  /** @param {string} p @param {RouteHandler} h */
  post(p, h) {
    return this.add('POST', p, h);
  }

  /** @param {string} p @param {RouteHandler} h */
  patch(p, h) {
    return this.add('PATCH', p, h);
  }

  /** @param {string} p @param {RouteHandler} h */
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  /**
   * @param {string} method
   * @param {string[]} segments decoded path segments
   * @returns {{ handler: RouteHandler, params: Record<string, string>, rest: string[] } | { allowed: string[] } | null}
   */
  match(method, segments) {
    const m = String(method).toUpperCase();
    /** @type {Set<string>} */
    const allowed = new Set();
    /** @type {{ handler: RouteHandler, params: Record<string, string>, rest: string[] } | null} */
    let getFallback = null;
    for (const route of this.routes) {
      const params = matchRoute(route, segments);
      if (!params) continue;
      if (route.method === m) return { handler: route.handler, params: params.params, rest: params.rest };
      if (m === 'HEAD' && route.method === 'GET' && !getFallback) getFallback = { handler: route.handler, params: params.params, rest: params.rest };
      allowed.add(route.method);
    }
    if (getFallback) return getFallback;
    if (allowed.has('GET')) allowed.add('HEAD');
    return allowed.size ? { allowed: [...allowed].sort() } : null;
  }
}

/**
 * @param {Route} route
 * @param {string[]} segments
 * @returns {{ params: Record<string, string>, rest: string[] } | null}
 */
function matchRoute(route, segments) {
  const { parts, wildcard } = route;
  if (wildcard ? segments.length < parts.length : segments.length !== parts.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind === 'static') {
      if (part.value !== segments[i]) return null;
    } else {
      params[part.value] = segments[i];
    }
  }
  const rest = wildcard ? segments.slice(parts.length) : [];
  if (wildcard) params['*'] = rest.join('/');
  return { params, rest };
}
