export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const routes = [];
export const RAW = Symbol.for('raw'); // le handler a déjà écrit la réponse

/** route('GET', '/api/x/:id', { auth: 'host' | 'player' }, async (ctx) => ({...})) */
export function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}
