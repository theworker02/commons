import fs from 'node:fs';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const backendTarget = process.env.COMMONS_FRONTEND_BACKEND || 'http://127.0.0.1:4173';
const pageAliases = {
  '/': '/index.html',
  '/observatory': '/index.html',
  '/onboard': '/onboard.html',
  '/onboard/': '/onboard.html',
  '/robots': '/robots.html',
  '/observatory/population': '/population.html'
};
const backendPaths = [
  '/api', '/v1', '/.well-known', '/developers', '/mcp', '/skill.md', '/openapi.json',
  '^/packages(?:\\?.*)?$', '^/robots/.+', '^/observatory/(?!population(?:[/?]|$))',
  '/home', '/latest', '/popular', '/explore', '/discover', '/search', '/work', '/projects', '/repositories', '/code', '/status',
  '/activity', '/articles', '/editor', '/research', '/evidence', '/proposals', '/challenges', '/agents', '/identity', '/operations',
  '/services', '/topics', '/conversations', '/federation', '/sessions', '/provenance', '/notifications', '/messages',
  '/communities', '/guilds', '/moderation', '/governance', '/council', '/settings', '^/@', '^/a/', '^/r/', '^/c/', '^/g/',
  '^/conversation/', '^/p/', '^/join/'
];
const proxy = Object.fromEntries(backendPaths.map((path) => [path, { target: backendTarget, changeOrigin: true }]));
const runtimeAssets = [
  'app.js', 'styles.css', 'analytics.js', 'navigation-shared.js', 'navigation.js', 'navigation.css',
  'social.js', 'social.css', 'public-pages.css',
  'packages/design-tokens/tokens.css', 'packages/design-tokens/tokens.json', 'packages/design-tokens/tokens.ts',
  'packages/design-system/index.css', 'packages/design-system/index.js', 'packages/design-system/skill.md'
];

function pageAliasMiddleware(request, _response, next) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  const target = pageAliases[requestUrl.pathname];
  if (target) request.url = `${target}${requestUrl.search}`;
  next();
}

function pageAliasesPlugin() {
  return {
    name: 'commons-clean-page-aliases',
    configureServer(server) {
      server.middlewares.use(pageAliasMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(pageAliasMiddleware);
    }
  };
}

function runtimeAssetsPlugin() {
  return {
    name: 'commons-runtime-assets',
    apply: 'build',
    generateBundle() {
      for (const relativePath of runtimeAssets) {
        const sourcePath = resolve(root, relativePath);
        if (!fs.existsSync(sourcePath)) throw new Error(`Missing frontend runtime asset: ${relativePath}`);
        this.emitFile({ type: 'asset', fileName: relativePath, source: fs.readFileSync(sourcePath) });
      }
    }
  };
}

export default defineConfig({
  root,
  plugins: [pageAliasesPlugin(), runtimeAssetsPlugin()],
  server: {
    host: process.env.VITE_HOST || '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    proxy
  },
  preview: {
    host: process.env.VITE_HOST || '127.0.0.1',
    port: Number(process.env.VITE_PREVIEW_PORT || 4174)
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        onboard: resolve(root, 'onboard.html'),
        population: resolve(root, 'population.html'),
        robots: resolve(root, 'robots.html')
      }
    }
  }
});
