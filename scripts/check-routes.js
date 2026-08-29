const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routes = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'routes.json'), 'utf8'));
const frontendPages = { '/': '/index.html', '/onboard': '/onboard.html', '/robots': '/robots.html', '/observatory': '/index.html', '/observatory/population': '/population.html' };
const frontendOwned = new Set(Object.keys(frontendPages));
const required = [
  ...Object.keys(routes.browserRoutes).filter((source) => !frontendOwned.has(source)),
  ...routes.staticRoutes.filter((source) => !frontendOwned.has(source)),
  ...routes.dynamicRoutes
];
const duplicates = required.filter((source, index) => required.indexOf(source) !== index);
if (duplicates.length) throw new Error(`Duplicate route metadata: ${[...new Set(duplicates)].join(', ')}`);

function validateVercel(relativePath) {
  const filePath = path.join(root, relativePath);
  const vercel = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rewriteSources = new Set((vercel.rewrites || []).map((rewrite) => rewrite.source));
  const missing = required.filter((source) => !rewriteSources.has(source));
  for (const [source, destination] of Object.entries(frontendPages)) {
    const localRewrite = (vercel.rewrites || []).find((rewrite) => rewrite.source === source);
    if (!localRewrite || localRewrite.destination !== destination) throw new Error(`${relativePath} must map frontend-owned ${source} to ${destination}`);
  }
  for (const rewrite of vercel.rewrites || []) {
    if (typeof rewrite.destination !== 'string' || (!/^https:\/\//.test(rewrite.destination) && !rewrite.destination.startsWith('/'))) throw new Error(`${relativePath} has an invalid destination for ${rewrite.source}`);
  }
  return { relativePath, rewrites: rewriteSources.size };
}

for (const [source, value] of Object.entries(routes.browserRoutes)) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== 'string' || !item)) throw new Error(`Invalid browser route metadata: ${source}`);
}
const pages = { '/': 'index.html', '/onboard': 'onboard.html', '/robots': 'robots.html', '/observatory': 'index.html', '/observatory/population': 'population.html' };
for (const [source, file] of Object.entries(pages)) {
  if (!fs.existsSync(path.join(root, 'frontend', file))) throw new Error(`Frontend page for ${source} is missing: frontend/${file}`);
}
const configs = [validateVercel('vercel.json'), validateVercel(path.join('frontend', 'vercel.json'))];
console.log(`ROUTES_OK ${required.length} ${configs.map((config) => `${config.relativePath}:${config.rewrites}`).join(' ')}`);
