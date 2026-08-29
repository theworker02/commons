#!/usr/bin/env node
'use strict';

/**
 * Fails if the MCP tool surface advertised by the backend /mcp manifest drifts from
 * the tools the MCP server actually implements. The backend deliberately keeps its own
 * copy of the list so it stays deployable without the MCP package; this check is what
 * keeps that copy honest.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];

const { TOOL_LIST } = require(path.join(root, 'packages', 'mcp', 'server.js'));
const implemented = TOOL_LIST.map((tool) => tool.name);
const implementedAuth = TOOL_LIST.filter((tool) => tool.auth === 'required').map((tool) => tool.name);

const backendSource = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const readArray = (name) => {
  const match = backendSource.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  if (!match) { problems.push(`${name} not found in backend/server.js`); return null; }
  try { return JSON.parse(match[1].replace(/'/g, '"')); } catch (error) { problems.push(`${name} is not parseable: ${error.message}`); return null; }
};

const compare = (label, expected, actual) => {
  if (!actual) return;
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length) problems.push(`${label} is missing: ${missing.join(', ')}`);
  if (extra.length) problems.push(`${label} advertises tools the server does not implement: ${extra.join(', ')}`);
};

compare('MCP_TOOLS', implemented, readArray('MCP_TOOLS'));
compare('MCP_AUTHENTICATED_TOOLS', implementedAuth, readArray('MCP_AUTHENTICATED_TOOLS'));

// Every tool must map onto a real REST path so the manifest cannot promise endpoints
// the API does not serve.
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'openapi.json'), 'utf8'));
const asPattern = (template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
const documented = Object.keys(openapi.paths || {}).map(asPattern);
// Served by backend/server.js but absent from openapi.json.
const knownUndocumented = ['/api/v1/posts/{post_id}'].map(asPattern);

const sampleArgs = { post_id: 'sample', agent_id: 'sample', robot_id: 'sample', skill_id: 'sample', community_id: 'sample', q: 'sample' };

for (const tool of TOOL_LIST) {
  // Connection-management tools drive the pairing handshake in code rather than
  // mapping to a single REST path, so there is nothing to compare.
  if (typeof tool.handler === 'function' && typeof tool.request !== 'function') continue;
  if (typeof tool.request !== 'function') {
    problems.push(`${tool.name} has neither a request builder nor a handler`);
    continue;
  }
  let spec;
  try {
    spec = tool.request(sampleArgs);
  } catch (error) {
    problems.push(`${tool.name} could not build a request: ${error.message}`);
    continue;
  }
  const target = spec.path.split('?')[0];
  const known = documented.some((pattern) => pattern.test(target)) || knownUndocumented.some((pattern) => pattern.test(target));
  if (!known) problems.push(`${tool.name} targets ${spec.method} ${target}, which is not a documented REST path`);
}

if (problems.length) {
  for (const problem of problems) console.error(`MCP_MANIFEST_DRIFT: ${problem}`);
  process.exit(1);
}

console.log(`MCP_MANIFEST_OK ${implemented.length} tools, ${implementedAuth.length} authenticated`);
