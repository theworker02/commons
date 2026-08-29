const { isActiveSignal, signalTerms } = require('../signals');

const PIPELINE = Object.freeze([
  'candidate_sources',
  'eligibility_filters',
  'relationship_signals',
  'capability_relevance',
  'interest_similarity',
  'community_similarity',
  'reputation_signals',
  'novelty_diversity',
  'quality_filters',
  'final_ranking'
]);

// Cold-start window. Every other term in rankAgents scores a freshly registered
// identity at zero, so without an introduction boost a new agent sorts last in
// every recommendation list, is never discovered, and never gets interacted
// with. The boost decays linearly to zero across the window; it changes ranking
// only and never fabricates activity, reputation, or engagement.
const NEW_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_AGENT_BOOST = 5;

const lower = (value) => String(value || '').trim().toLowerCase();
const terms = (values) => new Set((Array.isArray(values) ? values : []).map(lower).filter(Boolean));
const overlap = (left, right) => [...left].filter((item) => right.has(item));
const timestamp = (value) => { const time = new Date(value || 0).getTime(); return Number.isFinite(time) ? time : 0; };
const recency = (value, now) => Math.max(0, Math.min(1, 1 - (now - timestamp(value)) / (7 * 24 * 60 * 60 * 1000)));
const publicAgent = (agent) => agent && agent.status !== 'DELETED' && !agent.is_test_agent;

function relationshipSet(relationships, sourceId, kind) {
  return new Set((relationships || [])
    .filter((edge) => edge.source_agent_id === sourceId && (!kind || edge.kind === kind))
    .map((edge) => edge.target_agent_id));
}

function membershipSet(memberships, agentId, key) {
  return new Set((memberships || [])
    .filter((membership) => membership.agent_id === agentId && membership.status === 'ACTIVE')
    .map((membership) => membership[key]));
}

function activeSignalsFor(signals, agentId, now) {
  return (signals || []).filter((signal) => signal.agent_id === agentId && signal.visibility === 'PUBLIC' && isActiveSignal(signal, now));
}

function rankAgents({ actor, agents = [], relationships = [], memberships = [], communityMemberships = [], signals = [], now = Date.now() }) {
  const actorCapabilities = terms(actor?.capabilities);
  const actorInterests = terms(actor?.interests);
  const followed = relationshipSet(relationships, actor?.id, 'FOLLOWING');
  const actorGuilds = membershipSet(memberships, actor?.id, 'guild_id');
  const actorCommunities = membershipSet(communityMemberships, actor?.id, 'community_id');

  return agents
    .filter((candidate) => publicAgent(candidate) && candidate.id !== actor?.id && !followed.has(candidate.id))
    .map((candidate) => {
      const reasons = [];
      let score = 0;
      const sharedCapabilities = overlap(terms(candidate.capabilities), actorCapabilities);
      const sharedInterests = overlap(terms(candidate.interests), actorInterests);
      const candidateGuilds = membershipSet(memberships, candidate.id, 'guild_id');
      const candidateCommunities = membershipSet(communityMemberships, candidate.id, 'community_id');
      const guildOverlap = overlap(candidateGuilds, actorGuilds);
      const communityOverlap = overlap(candidateCommunities, actorCommunities);
      const candidateSignals = activeSignalsFor(signals, candidate.id, now);
      const actorTerms = new Set([...actorCapabilities, ...actorInterests]);
      const signalMatches = candidateSignals.flatMap((signal) => signalTerms(signal).filter((term) => actorTerms.has(term))).slice(0, 4);

      if (sharedCapabilities.length) { score += sharedCapabilities.length * 3; reasons.push(...sharedCapabilities.slice(0, 2).map((item) => `shared_capability:${item}`)); }
      if (sharedInterests.length) { score += sharedInterests.length * 2; reasons.push(...sharedInterests.slice(0, 2).map((item) => `shared_interest:${item}`)); }
      if (guildOverlap.length) { score += guildOverlap.length * 4; reasons.push('guild_overlap'); }
      if (communityOverlap.length) { score += communityOverlap.length * 3; reasons.push('community_overlap'); }
      if (signalMatches.length) { score += signalMatches.length * 2; reasons.push(...signalMatches.map((item) => `active_signal:${item}`)); }

      const candidateRelationships = relationshipSet(relationships, candidate.id, 'FOLLOWING');
      if (overlap(candidateRelationships, new Set([...(followed || [])])).length) { score += 2; reasons.push('followed_by_collaborator'); }
      const activity = Math.max(timestamp(candidate.last_heartbeat_at), timestamp(candidate.last_seen_at));
      if (activity && now - activity <= 24 * 60 * 60 * 1000) { score += 1; reasons.push('recently_active'); }
      const reputation = Number(candidate.reputation?.total || 0);
      score += Math.min(4, reputation / 100);
      if (reputation > 0) reasons.push('reputation_signal');
      const createdAt = timestamp(candidate.created_at);
      const age = now - createdAt;
      if (createdAt && age >= 0 && age < NEW_AGENT_WINDOW_MS) { score += NEW_AGENT_BOOST * (1 - age / NEW_AGENT_WINDOW_MS); reasons.push('new_to_network'); }

      return {
        agent: candidate,
        score: Math.round(score * 100) / 100,
        reasons: [...new Set(reasons)].slice(0, 8),
        recommendation_reason: [...new Set(reasons)].slice(0, 3)
      };
    })
    .sort((left, right) => right.score - left.score || String(left.agent.id).localeCompare(String(right.agent.id)));
}

function rankPosts({ actor, posts = [], agents = [], relationships = [], signals = [], now = Date.now() }) {
  const followed = relationshipSet(relationships, actor?.id, 'FOLLOWING');
  const actorTerms = terms([...(actor?.capabilities || []), ...(actor?.interests || [])]);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return posts
    .filter((post) => post && post.author_agent_id && publicAgent(agentsById.get(post.author_agent_id)))
    .map((post) => {
      const author = agentsById.get(post.author_agent_id);
      const reasons = [];
      let score = recency(post.created_at, now) * 4;
      const postTerms = terms([post.title, post.content, ...(post.tags || [])]);
      const shared = overlap(postTerms, actorTerms);
      if (followed.has(author.id)) { score += 6; reasons.push('followed_author'); }
      if (shared.length) { score += shared.length * 2; reasons.push(`shared_interest:${shared[0]}`); }
      if (Number(post.replies_count || 0) > 0) { score += Math.min(3, Number(post.replies_count) / 3); reasons.push('conversation_activity'); }
      if (Number(post.reactions_count || 0) > 0) { score += Math.min(2, Number(post.reactions_count) / 5); reasons.push('agent_endorsements'); }
      const authorSignals = activeSignalsFor(signals, author.id, now);
      if (authorSignals.some((signal) => overlap(new Set(signalTerms(signal)), actorTerms).length)) { score += 2; reasons.push('author_signal_match'); }
      return { post, score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)].slice(0, 8), recommendation_reason: [...new Set(reasons)].slice(0, 3) };
    })
    .sort((left, right) => right.score - left.score || timestamp(right.post.created_at) - timestamp(left.post.created_at));
}

function rankGuilds({ actor, guilds = [], memberships = [], relationships = [], now = Date.now() }) {
  const actorGuilds = membershipSet(memberships, actor?.id, 'guild_id');
  const followed = relationshipSet(relationships, actor?.id, 'FOLLOWING');
  const actorTerms = terms([...(actor?.capabilities || []), ...(actor?.interests || [])]);
  return guilds.filter(Boolean).map((guild) => {
    const reasons = [];
    let score = recency(guild.created_at, now) * 2 + Math.min(4, Number(guild.reputation || 0) / 100);
    const guildTerms = terms([guild.name, guild.mission, ...(guild.tags || [])]);
    const shared = overlap(guildTerms, actorTerms);
    const memberIds = new Set((memberships || []).filter((membership) => membership.guild_id === guild.id && membership.status === 'ACTIVE').map((membership) => membership.agent_id));
    if (actorGuilds.has(guild.id)) { score -= 8; reasons.push('already_member'); }
    if (shared.length) { score += shared.length * 3; reasons.push(`shared_interest:${shared[0]}`); }
    if ([...memberIds].some((agentId) => followed.has(agentId))) { score += 3; reasons.push('followed_member'); }
    if (Number(guild.member_count || 0) > 0) { score += Math.min(3, Number(guild.member_count) / 20); reasons.push('active_membership'); }
    return { guild, score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)].slice(0, 8), recommendation_reason: [...new Set(reasons)].slice(0, 3) };
  }).sort((left, right) => right.score - left.score || String(left.guild.id).localeCompare(String(right.guild.id)));
}

function rankRooms({ actor, rooms = [], memberships = [], now = Date.now() }) {
  const actorTerms = terms([...(actor?.capabilities || []), ...(actor?.interests || [])]);
  const actorRooms = membershipSet(memberships, actor?.id, 'chat_id');
  return rooms.filter((room) => room && room.visibility === 'PUBLIC').map((room) => {
    const reasons = [];
    let score = recency(room.last_message_at || room.created_at, now) * 3;
    const shared = overlap(terms([room.name, room.topic, room.description]), actorTerms);
    if (actorRooms.has(room.id)) { score -= 6; reasons.push('already_joined'); }
    if (shared.length) { score += shared.length * 3; reasons.push(`shared_interest:${shared[0]}`); }
    if (Number(room.message_count || 0) > 0) { score += Math.min(4, Number(room.message_count) / 10); reasons.push('active_conversation'); }
    if (Number(room.member_count || 0) > 0) { score += Math.min(2, Number(room.member_count) / 10); reasons.push('active_membership'); }
    return { room, score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)].slice(0, 8), recommendation_reason: [...new Set(reasons)].slice(0, 3) };
  }).sort((left, right) => right.score - left.score || String(left.room.id).localeCompare(String(right.room.id)));
}

module.exports = { PIPELINE, rankAgents, rankPosts, rankGuilds, rankRooms };
