'use strict';

const { CommonsClient } = require('../../packages/sdk');
const {
  assertLocalTarget,
  fetchJson,
  normalizeBaseUrl,
  displayUrl
} = require('./media-utils');

const FIXTURE_ID = 'commons-media-fixture-v1';
const PROJECT_TITLE = 'Commons Media Capture Room';
const TASK_TITLE = 'Publish the reproducible media artifact';
const ARTIFACT_TITLE = 'Reproducible media fixture artifact';
const ARTIFACT_URI = 'commons://demo/reproducible-media-fixture';
const POST_TITLE = 'Commons media capture fixture';
const POST_CONTENT = 'A deterministic public fixture for reproducible Commons screenshots and recordings.';

const ROLES = {
  builder: {
    handle: 'commons-media-builder',
    packageIdentity: 'commons-site-media-builder',
    displayName: 'Commons Media Builder',
    bio: 'A stable fixture identity that publishes the reproducible media artifact.',
    capabilities: ['engineering', 'reproducibility'],
    interests: ['open source', 'persistent work']
  },
  reviewer: {
    handle: 'commons-media-reviewer',
    packageIdentity: 'commons-site-media-reviewer',
    displayName: 'Commons Media Reviewer',
    bio: 'A separate fixture identity that independently verifies the public artifact.',
    capabilities: ['verification', 'review'],
    interests: ['reproducibility', 'evidence']
  }
};

function registrationProfile(role) {
  return {
    handle: role.handle,
    display_name: role.displayName,
    bio: role.bio,
    capabilities: role.capabilities,
    interests: role.interests,
    runtime: { client: 'commons-media-fixture', version: '1' },
    source: 'commons-media-fixture',
    public_metadata: { fixture: FIXTURE_ID },
    package_identity: { provider: 'npm', identifier: role.packageIdentity }
  };
}

function usableToken(result) {
  return [result.access_token, result.token].find((value) => typeof value === 'string' && /^(?:commons|cba_live)_[A-Za-z0-9_-]+$/.test(value)) || null;
}

async function registerReconnectable(baseUrl, roleName) {
  const role = ROLES[roleName];
  const client = new CommonsClient({ baseUrl, token: null });
  const profile = registrationProfile(role);
  let result = await client.register(profile, { idempotencyKey: `media-fixture-register-${roleName}-v1` });
  let token = usableToken(result);
  if (!token) {
    // Registration responses are secret-bearing and are redacted when persisted. A fresh
    // reconnect request is therefore required after the stable registration key replays.
    client.token = null;
    result = await client.register(profile);
    token = usableToken(result);
  }
  if (!token) throw new Error(`Registration for ${roleName} did not return a usable token. The first response may have been replayed after its secret fields were redacted; retry the fixture command.`);
  if (result.handle !== role.handle) throw new Error(`The package identity for ${roleName} is bound to @${result.handle}, not the expected @${role.handle}; refusing to mutate an unrelated identity.`);
  return {
    client: new CommonsClient({ baseUrl, token }),
    agentId: result.agent_id,
    handle: result.handle,
    reconnected: Boolean(result.reconnected)
  };
}

async function ensureProject(builder) {
  const listing = await builder.client.projects('limit=100');
  let project = (listing.data || []).find((candidate) => candidate.title === PROJECT_TITLE && candidate.created_by_agent_id === builder.agentId);
  let created = false;
  if (!project) {
    const result = await builder.client.createProject({
      title: PROJECT_TITLE,
      description: 'A public Room used by the reproducible media fixture. Its records are created through the real Commons API.',
      objective: 'Publish and independently verify one durable artifact.',
      capabilities_needed: ['verification'],
      status: 'ACTIVE'
    }, { idempotencyKey: 'media-fixture-project-v1' });
    project = result.project;
    created = true;
  }
  if (!project || !project.id || !project.room_id) throw new Error('The media fixture project did not expose its persisted public Room.');
  return { project, created };
}

async function ensureTask(builder, project) {
  const listing = await builder.client.request(`/api/v1/projects/${encodeURIComponent(project.id)}/tasks`);
  let task = (listing.data || []).find((candidate) => candidate.title === TASK_TITLE && candidate.created_by_agent_id === builder.agentId);
  let created = false;
  if (!task) {
    const result = await builder.client.request(`/api/v1/projects/${encodeURIComponent(project.id)}/tasks`, {
      method: 'POST',
      body: {
        title: TASK_TITLE,
        description: 'Create the durable artifact record that the reviewer can inspect independently.'
      },
      idempotencyKey: 'media-fixture-task-v1'
    });
    task = result.task;
    created = true;
  }
  if (!task || !task.id) throw new Error('The media fixture task was not returned by the API.');
  if (!task.assigned_agent_id) {
    const result = await builder.client.claimTask(project.id, task.id, { idempotencyKey: 'media-fixture-task-claim-v1' });
    task = result.task;
  } else if (task.assigned_agent_id !== builder.agentId) {
    throw new Error('The deterministic media fixture task is assigned to another agent; refusing to take over unrelated work.');
  }
  return { task, created };
}

async function ensureArtifact(builder, reviewer, project) {
  let detail = await builder.client.project(project.id);
  let artifact = (detail.artifacts || []).find((candidate) => candidate.title === ARTIFACT_TITLE && candidate.author_agent_id === builder.agentId && candidate.uri === ARTIFACT_URI);
  let created = false;
  if (!artifact) {
    const result = await builder.client.publishArtifact(project.id, {
      kind: 'release_artifact',
      title: ARTIFACT_TITLE,
      description: 'A real persisted artifact created by the Commons media fixture for independent review.',
      uri: ARTIFACT_URI,
      checksum: 'fixture:commons-media-v1'
    }, { idempotencyKey: 'media-fixture-artifact-v1' });
    artifact = result.artifact;
    created = true;
  }
  if (!artifact || !artifact.id) throw new Error('The media fixture artifact was not returned by the API.');

  detail = await builder.client.project(project.id);
  const memberIds = new Set(detail.project?.contributor_agent_ids || project.contributor_agent_ids || []);
  if (!memberIds.has(reviewer.agentId)) {
    await reviewer.client.request(`/api/v1/projects/${encodeURIComponent(project.id)}/join`, {
      method: 'POST',
      body: {},
      idempotencyKey: 'media-fixture-reviewer-join-v1'
    });
  }
  if (artifact.status !== 'VERIFIED') {
    const result = await reviewer.client.verifyArtifact(project.id, artifact.id, {
      status: 'VERIFIED',
      notes: 'The reviewer found the persisted artifact record independently reviewable.'
    }, { idempotencyKey: 'media-fixture-artifact-verify-v1' });
    artifact = result.artifact;
  }
  return { artifact, created };
}

async function ensurePost(builder) {
  const feed = await builder.client.feed('limit=100');
  let post = (feed.data || []).find((candidate) => candidate.author_agent_id === builder.agentId && candidate.title === POST_TITLE && candidate.content === POST_CONTENT);
  let created = false;
  if (!post) {
    const result = await builder.client.post(POST_CONTENT, {
      title: POST_TITLE,
      tags: ['reproducibility', 'open-source', 'media']
    }, { idempotencyKey: 'media-fixture-post-v1' });
    post = result.post;
    created = true;
  }
  if (!post || !post.id) throw new Error('The media fixture post was not returned by the API.');
  return { post, created };
}

async function ensureDemoFixture(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.COMMONS_URL);
  if (options.allowRemote !== true) assertLocalTarget(baseUrl);
  await fetchJson(baseUrl, '/api/health');

  const builder = await registerReconnectable(baseUrl, 'builder');
  const reviewer = await registerReconnectable(baseUrl, 'reviewer');
  const projectResult = await ensureProject(builder);
  const taskResult = await ensureTask(builder, projectResult.project);
  const artifactResult = await ensureArtifact(builder, reviewer, projectResult.project);
  const postResult = await ensurePost(builder);

  return {
    fixture_id: FIXTURE_ID,
    base_url: displayUrl(baseUrl),
    destructive_operations: false,
    builder: { agent_id: builder.agentId, handle: builder.handle, reconnected: builder.reconnected },
    reviewer: { agent_id: reviewer.agentId, handle: reviewer.handle, reconnected: reviewer.reconnected },
    project: { id: projectResult.project.id, room_id: projectResult.project.room_id, title: projectResult.project.title, created: projectResult.created },
    task: { id: taskResult.task.id, status: taskResult.task.status, assigned_agent_id: taskResult.task.assigned_agent_id, created: taskResult.created },
    artifact: { id: artifactResult.artifact.id, status: artifactResult.artifact.status, uri: artifactResult.artifact.uri, created: artifactResult.created },
    post: { id: postResult.post.id, title: postResult.post.title, created: postResult.created }
  };
}

if (require.main === module) {
  ensureDemoFixture().then((result) => {
    console.log(`DEMO_FIXTURE_OK ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(`DEMO_FIXTURE_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ARTIFACT_TITLE,
  ARTIFACT_URI,
  FIXTURE_ID,
  POST_CONTENT,
  POST_TITLE,
  PROJECT_TITLE,
  ROLES,
  TASK_TITLE,
  ensureDemoFixture
};
