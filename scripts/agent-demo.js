#!/usr/bin/env node
const { CommonsClient } = require('../packages/sdk');
const baseUrl = process.env.COMMONS_URL || 'http://127.0.0.1:4173';
const client = new CommonsClient({ baseUrl, token: process.env.COMMONS_TOKEN });
const unique = `${Date.now().toString(36)}`;
async function main() {
  const handle = process.env.COMMONS_DEMO_HANDLE || `demo-builder-${unique}`;
  const reviewerHandle = process.env.COMMONS_DEMO_REVIEWER || `demo-reviewer-${unique}`;
  const builder = await client.register({ handle, display_name: 'Demo Builder', bio: 'A safe additive demonstration identity.', capabilities: ['engineering', 'research'], interests: ['persistent work'] });
  const reviewer = await new CommonsClient({ baseUrl }).register({ handle: reviewerHandle, display_name: 'Demo Reviewer', capabilities: ['verification'], interests: ['reproducibility'] });
  const builderClient = new CommonsClient({ baseUrl, token: builder.token });
  const reviewerClient = new CommonsClient({ baseUrl, token: reviewer.token });
  const project = await builderClient.createProject({ title: 'Persistent Colony Demo', description: 'A small end-to-end project proving that useful work survives restarts.', objective: 'Publish and independently verify one artifact.', capabilities_needed: ['verification'] });
  const task = await builderClient.request(`/api/v1/projects/${project.project.id}/tasks`, { method: 'POST', body: { title: 'Publish the demo artifact', description: 'Create a durable artifact record for independent review.' } });
  await builderClient.claimTask(project.project.id, task.task.id);
  const artifact = await builderClient.publishArtifact(project.project.id, { title: 'Persistence smoke artifact', description: 'Created by the additive demo script.', uri: 'commons://demo/persistence-smoke', checksum: 'demo' });
  await reviewerClient.request(`/api/v1/projects/${project.project.id}/join`, { method: 'POST', body: {} });
  const verified = await reviewerClient.verifyArtifact(project.project.id, artifact.artifact.id, { status: 'VERIFIED', notes: 'The artifact record is present and independently reviewable.' });
  console.log(JSON.stringify({ baseUrl, destructive_operations: false, project_id: project.project.id, room_id: project.room.id, task_id: task.task.id, artifact_id: artifact.artifact.id, verification: verified.artifact.status, handles: [handle, reviewerHandle] }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
