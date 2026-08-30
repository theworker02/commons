// Validates the single-origin route table.
//
// The frontend and the API are served by one process from one origin: the
// backend owns every browser surface in backend/routes.json, and falls back to
// staticRoute() for HTML authored in frontend/. There is no proxy rewrite table
// to keep in sync any more, so this check verifies internal consistency instead
// of cross-origin forwarding:
//
//   - route metadata is well-formed and free of duplicates
//   - every static page the backend serves exists in frontend/
//   - no route declares an absolute cross-origin destination
//
// Run with `npm run check:routes`.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routes = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'routes.json'), 'utf8'));

// HTML authored in frontend/ and handed to the backend's staticRoute(). The
// backend maps '/' and '/observatory' to index.html internally.
const staticPages = {
  '/': 'index.html',
  '/onboard': 'onboard.html',
  '/robots': 'robots.html',
  '/observatory': 'index.html',
  '/observatory/population': 'population.html'
};

const browserRoutes = routes.browserRoutes || {};
const staticRoutes = routes.staticRoutes || [];
const dynamicRoutes = routes.dynamicRoutes || [];

// Every surface the one origin is expected to answer.
const declared = [...Object.keys(browserRoutes), ...staticRoutes, ...dynamicRoutes];

const duplicates = declared.filter((source, index) => declared.indexOf(source) !== index);
if (duplicates.length) throw new Error(`Duplicate route metadata: ${[...new Set(duplicates)].join(', ')}`);

for (const [source, value] of Object.entries(browserRoutes)) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`Invalid browser route metadata: ${source}`);
  }
}

// A single origin means every declared surface is a path, never an absolute URL.
for (const source of declared) {
  if (typeof source !== 'string' || !source.startsWith('/')) {
    throw new Error(`Route must be a rooted path on the single origin: ${String(source)}`);
  }
  if (/^https?:\/\//i.test(source)) {
    throw new Error(`Route must not point at a second origin: ${source}`);
  }
}

for (const [source, file] of Object.entries(staticPages)) {
  if (!fs.existsSync(path.join(root, 'frontend', file))) {
    throw new Error(`Static page for ${source} is missing: frontend/${file}`);
  }
}

// The two-origin Vercel proxy split is retired. Fail loudly if it comes back,
// because a rewrite table forwarding to a second hostname silently undoes the
// single-origin contract that OAuth redirect URIs and CORS depend on.
for (const stale of ['vercel.json', path.join('frontend', 'vercel.json')]) {
  if (fs.existsSync(path.join(root, stale))) {
    throw new Error(`${stale} reintroduces a second origin; the frontend and API are served from one origin`);
  }
}

console.log(`ROUTES_OK single-origin browser:${Object.keys(browserRoutes).length} static:${staticRoutes.length} dynamic:${dynamicRoutes.length} pages:${Object.keys(staticPages).length}`);
