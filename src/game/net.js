// net.js — Playroom Kit adapter for Catatumbo Protocol (host-authoritative).
//
// Model A: the HOST is the single source of truth. Each turn:
//   1. Both clients pick their plan locally, then call net.submit(plan).
//   2. Guest's submit RPCs 'cp:submitPlan' to the host; the host buffers the plan.
//   3. The HOST's own lockTurnNet, once it has both plans, runs the FULL resolution
//      (resolveTurn + throw + clash + zone, its own RNG) with access to its scene.
//      During resolution, sub-rounds for the guest are requested via RPC.
//   4. The host broadcasts { seq, segments } via setState('cp:result').
//   5. Both clients replay the identical segments (playEvents is deterministic).
//
// Why the host resolves OUTSIDE the RPC handler: resolution needs the live scene
// (throw/clash UI for the host's own seat). The RPC handler only transports plans.
//
// Contract the scene uses (see game.js lockTurnNet):
//   net.setSeq(n)
//   net.bindTurn({ run, localThrow, localClash })   // host: how to run a turn
//   net.onThrowRequest = (seq) => Promise<dir>      // guest answers host mid-resolution
//   net.onClashRequest = (seq) => Promise<pick>
//   net.submit(plan) -> Promise<void>               // publish our plan
//   net.waitBothPlans() -> Promise<[p0, p1]>        // host: both plans for this seq
//   net.broadcast(segments)                         // host: publish result
//   net.awaitResult(seq) -> Promise<segments>       // guest: wait for result
//
// Verified against docs.joinplayroom.com (MCP):
//   RPC.register(name, async (data, sender) => value)
//   RPC.call(name, data, mode) -> Promise<value>
//   setState(key, value, reliable = true)
//   waitForState(key, onSet?) -> Promise<value>

import {
  insertCoin,
  isHost,
  getRoomCode,
  setState,
  waitForState,
  RPC,
} from 'playroomkit';

const RPC_SUBMIT = 'cp:submitPlan';
const RPC_THROW = 'cp:throwDir';
const RPC_CLASH = 'cp:clashPick';
const STATE_RESULT = 'cp:result';

export async function createNetSession({ gameId, roomCode } = {}) {
  const id = gameId || new URLSearchParams(location.search).get('gameId');
  if (!id) throw new Error('Playroom gameId missing: pass ?gameId=... in the URL');
  const code = roomCode || new URLSearchParams(location.search).get('r') || undefined;

  await insertCoin({ gameId: id, roomCode: code, skipLobby: false });

  const host = isHost();
  const seat = host ? 0 : 1;

  let seq = 0;
  let turn = null; // { run, localThrow, localClash } set by bindTurn (host only)

  const planBuf = {};
  const planWaiters = {};
  const waitPlan = (s) =>
    new Promise((res) => {
      if (planBuf[s] !== undefined) return res(planBuf[s]);
      (planWaiters[s] = planWaiters[s] || []).push(res);
    });
  const deliverPlan = (s, plan) => {
    planBuf[s] = plan;
    (planWaiters[s] || []).forEach((fn) => fn(plan));
    planWaiters[s] = [];
  };

  // --- RPC handlers ---
  // Plan transport only: buffer the plan; the host's own lockTurnNet drives resolution.
  RPC.register(RPC_SUBMIT, async (data) => {
    if (!host) return null;
    if (data.seq !== seq) return null;
    deliverPlan(data.seat, data.plan);
    return true;
  });

  // Guest answers the host's mid-resolution sub-round requests.
  RPC.register(RPC_THROW, async (data) => {
    if (host) return null;
    return api.onThrowRequest ? api.onThrowRequest(data.seq) : null;
  });
  RPC.register(RPC_CLASH, async (data) => {
    if (host) return null;
    return api.onClashRequest ? api.onClashRequest(data.seq) : null;
  });

  const api = {
    seat,
    roomCode: getRoomCode(),
    isHost: host,
    onThrowRequest: null,
    onClashRequest: null,

    setSeq(n) {
      seq = n;
      delete planBuf[0];
      delete planBuf[1];
    },
    bindTurn(t) {
      turn = t;
    },

    // Publish our plan. Host buffers locally; guest RPCs to host.
    async submit(plan) {
      if (host) {
        deliverPlan(seat, plan);
        return;
      }
      await RPC.call(RPC_SUBMIT, { seq, seat, plan }, RPC.Mode.HOST);
    },

    // Host: wait for both plans for the current seq.
    async waitBothPlans() {
      return Promise.all([waitPlan(0), waitPlan(1)]);
    },

    // Host: broadcast the resolved segments.
    broadcast(segments) {
      setState(STATE_RESULT, { seq, segments });
    },

    // Guest: wait for the host's result for the current seq.
    async awaitResult() {
      let r = await waitForState(STATE_RESULT);
      // Guard against a stale result from a previous turn.
      while (r && r.seq !== seq) {
        r = await waitForState(STATE_RESULT);
      }
      return r.segments;
    },

    // Host: run the full turn with scene access, sourcing guest sub-rounds via RPC.
    async runHostTurn() {
      const plans = await api.waitBothPlans();
      const hooks = {
        throwDir: async (who) => {
          if (who === 0) return turn.localThrow();
          return RPC.call(RPC_THROW, { seq }, RPC.Mode.OTHERS);
        },
        clashPicks: async () => {
          const hostPick = turn.localClash();
          const guestPick = await RPC.call(RPC_CLASH, { seq }, RPC.Mode.OTHERS);
          return [hostPick, guestPick];
        },
      };
      const result = await turn.run(plans, hooks);
      api.broadcast(result.segments);
      return result;
    },
  };

  return api;
}
