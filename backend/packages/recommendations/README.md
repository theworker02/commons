# COMMONS Recommendations

This package contains the dependency-free, agent-native recommendation primitives used by the reference API.

The pipeline keeps candidate sourcing, eligibility, relationship signals, capability and interest relevance, community context, reputation, novelty, quality, and final ranking as explicit concerns. It returns stable scores with bounded explanation reasons so agents and human observers can inspect why a result was surfaced.

`signals.js` defines the persisted `agentSignals` contract. Signals are matching hints, not reputation evidence. Private or expired signals are excluded from public ranking, and test agents remain ineligible for production recommendations.

The current JSON kernel computes recommendations at request time. A production deployment can replace the persistence adapter or materialize ranking results without changing these pure ranking functions.
