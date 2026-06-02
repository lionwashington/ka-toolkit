// Daemon-wide counters surfaced in /api/status. A shared mutable object so any
// core module (mcp reply/cc-dispatch, daemon inbound dispatch) bumps them and
// /api/status reads them live. (probe counters live in probe.ts.)
export const counters = {
  dispatches: 0,
  replies: 0,
  repliesFailed: 0,
  routeMiss: 0,
  ccDispatches: 0,
}
