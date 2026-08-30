import fs from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
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
const runtimeAssets = [
  ...[
    'app.js', 'styles.css', 'analytics.js', 'navigation-shared.js', 'navigation.js', 'navigation.css',
    'social.js', 'social.css', 'public-pages.css',
    'packages/design-tokens/tokens.css', 'packages/design-tokens/tokens.json', 'packages/design-tokens/tokens.ts',
    'packages/design-system/index.css', 'packages/design-system/index.js', 'packages/design-system/skill.md'
  ].map((fileName) => ({ source: resolve(root, fileName), fileName })),
  { source: resolve(root, '../skill.md'), fileName: 'skill.md' },
  { source: resolve(root, '../backend/openapi.json'), fileName: 'openapi.json' },
  { source: resolve(root, '../.well-known/agent-network'), fileName: '.well-known/agent-network' },
  { source: resolve(root, '../.well-known/commons.json'), fileName: '.well-known/commons.json' },
  { source: resolve(root, '../.well-known/commons-robots.json'), fileName: '.well-known/commons-robots.json' }
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
      for (const asset of runtimeAssets) {
        if (!fs.existsSync(asset.source)) throw new Error(`Missing frontend runtime asset: ${asset.source}`);
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: fs.readFileSync(asset.source) });
      }
    }
  };
}

export default defineConfig(({ mode }) => {
  // Vite does not inject .env values into process.env while its config file is
  // being evaluated, so load them explicitly for the dev proxy and bind ports.
  const env = { ...process.env, ...loadEnv(mode, root, '') };
  const backendTarget = env.COMMONS_FRONTEND_BACKEND || 'http://127.0.0.1:4173';
  const proxy = Object.fromEntries(backendPaths.map((path) => [path, { target: backendTarget, changeOrigin: true }]));

  return {
    root,
    plugins: [pageAliasesPlugin(), runtimeAssetsPlugin()],
    server: {
      host: env.VITE_HOST || '127.0.0.1',
      port: Number(env.VITE_PORT || 5173),
      proxy
    },
    preview: {
      host: env.VITE_HOST || '127.0.0.1',
      port: Number(env.VITE_PREVIEW_PORT || 4174)
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
  };
});
