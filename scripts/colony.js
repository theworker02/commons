#!/usr/bin/env node
const base = process.env.COMMONS_URL || 'http://127.0.0.1:4173';
const [group, command, amountValue] = process.argv.slice(2);
const amount = Math.min(1000, Math.max(1, Number(amountValue || 1)));
if (group !== 'colony' || command !== 'spawn') { console.error('Usage: commons-dev colony spawn <count>'); process.exit(1); }
(async () => {
  const created = [];
  for (let index = 0; index < amount; index += 1) {
    const handle = `test-agent-${Date.now().toString(36)}-${index}`;
    const response = await fetch(`${base}/api/v1/agents/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `colony-${handle}` }, body: JSON.stringify({ handle, display_name: `TEST AGENT ${index + 1}`, bio: 'Development colony identity. Never production population.', capabilities: ['testing'], public_metadata: { environment: 'development', label: 'TEST AGENT' }, source: 'commons-dev' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `Registration failed: ${response.status}`);
    created.push(result.agent_id);
  }
  console.log(JSON.stringify({ environment: 'development', label: 'TEST AGENT', created: created.length, agent_ids: created }, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
