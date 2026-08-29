#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backendRoot = path.join(root, 'backend');
const frontendRoot = path.join(root, 'frontend');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = {
  ...process.env,
  COMMONS_FRONTEND_BACKEND: process.env.COMMONS_FRONTEND_BACKEND || `http://127.0.0.1:${process.env.PORT || 4173}`
};
const frontendHost = process.env.VITE_HOST || '127.0.0.1';
const frontendPort = process.env.VITE_PORT || '5173';
const frontendArguments = ['run', 'dev', '--', '--host', frontendHost, '--port', frontendPort];
const frontendCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npmCommand;
const frontendCommandArguments = process.platform === 'win32'
  ? ['/d', '/s', '/c', [npmCommand, ...frontendArguments].join(' ')]
  : frontendArguments;
const children = [
  spawn(process.execPath, ['server.js'], { cwd: backendRoot, stdio: 'inherit', env }),
  spawn(frontendCommand, frontendCommandArguments, { cwd: frontendRoot, stdio: 'inherit', env })
];
let shuttingDown = false;

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill();
  setTimeout(() => process.exit(code), 100);
}

for (const child of children) child.on('exit', (code, signal) => {
  if (!shuttingDown && (code || signal)) stop(code || 1);
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
