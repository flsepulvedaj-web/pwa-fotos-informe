const routes = [];
let notFoundHandler = null;

export function registerRoute(pattern, handler) {
  // pattern ejemplo: '/folder/:id' o '/camera' o '/'
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ regex, paramNames, handler });
}

export function registerNotFound(handler) {
  notFoundHandler = handler;
}

export function navigate(path) {
  window.location.hash = path;
}

function currentPath() {
  const hash = window.location.hash.slice(1);
  return hash || '/';
}

function resolve() {
  const path = currentPath();
  for (const route of routes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      route.handler(params);
      return;
    }
  }
  if (notFoundHandler) notFoundHandler();
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  resolve();
}
