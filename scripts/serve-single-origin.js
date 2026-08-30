#!/usr/bin/env node
// Builds the frontend, then serves the frontend AND the API from ONE origin.
//
//   npm run start:single-origin
//   npm run start:single-origin -- --skip-build     reuse an existing dist
//   npm run start:single-origin -- --port 8080
//
// This is the combined topology: a single Node process listening on a single
// port answers API routes, discovery documents, the skill registry, the
// server-rendered browser surfaces, and the built static pages. There is no
// proxy layer and no second hostname, which is what OAuth redirect URIs,
// .well-known discovery and a same-origin CSP all quietly depend on.
//
// It works by pointing COMMONS_FRONTEND_ROOT at frontend/dist. The backend's
// staticRoute() resolves files under that root and already accepts either the
// built layout (dist/assets/...) or the source layout (frontend/public/...), so
// --skip-build against the source tree also works for a quick loop.
//
// For iterating on frontend code with hot reload, use `npm run dev` instead:
// that intentionally runs two ports (backend 4173, Vite 5173) with Vite
// proxying API paths, which is a development convenience rather than the
// deployed shape.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

function hasFlag(name) { return process.argv.includes(name); }
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

// npm is a shell script on POSIX and a .cmd shim on Windows, so it needs a shell
// on Windows to be executable via spawn.
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: ROOT,
      ...(isWindows ? { shell: true } : {}),
      ...options
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${command} terminated with ${signal}`));
      if (code !== 0) return reject(new Error(`${command} exited with code ${code}`));
      resolve();
    });
  });
}

async function main() {
  const distPath = path.join(ROOT, 'frontend', 'dist');
  const skipBuild = hasFlag('--skip-build');

  if (skipBuild) {
    if (!fs.existsSync(distPath)) {
      // Fall back to the source tree rather than serving nothing. The backend
      // handles both layouts, and the pages use classic scripts, not bundled
      // modules, so the source tree is directly servable.
      console.log('single-origin: no frontend/dist and --skip-build was passed; serving the frontend source tree instead.');
    }
  } else {
    console.log('single-origin: building the frontend into frontend/dist ...');
    await run('npm', ['--prefix', 'frontend', 'run', 'build']);
  }

  const frontendRoot = fs.existsSync(distPath) ? 'frontend/dist' : 'frontend';
  const port = option('--port') || process.env.PORT || '4173';
  const host = option('--host') || process.env.HOST || '127.0.0.1';

  console.log(`single-origin: serving API + frontend from http://${host}:${port} (COMMONS_FRONTEND_ROOT=${frontendRoot})`);

  await run('node', ['server.js'], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, COMMONS_FRONTEND_ROOT: frontendRoot, PORT: port, HOST: host },
    // server.js is invoked directly, so no shell is needed even on Windows.
    shell: false
  });
}

main().catch((error) => {
  console.error(`SINGLE_ORIGIN_FAILED ${error.message}`);
  process.exitCode = 1;
});
