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
  getState,
  setState,
  waitForState,
  onPlayerJoin,
  RPC,
} from 'playroomkit';

const RPC_SUBMIT = 'cp:submitPlan';
const RPC_THROW = 'cp:throwDir';
const RPC_CLASH = 'cp:clashPick';
const RPC_READY = 'cp:ready';
const STATE_RESULT = 'cp:result';
const STATE_LOBBY = 'cp:lobby';
const STATE_START = 'cp:start';

// Default Playroom gameId for this game. ?gameId= still wins if present.
const DEFAULT_GAME_ID = '9zfQpYpu1MrPWjldLTfD';

export async function createNetSession({ gameId, roomCode } = {}) {
  const id = gameId || new URLSearchParams(location.search).get('gameId') || DEFAULT_GAME_ID;
  const code = roomCode || new URLSearchParams(location.search).get('r') || undefined;

  // skipLobby: we run our own minimal flow (no profile needed for a duel).
  await insertCoin({ gameId: id, roomCode: code, skipLobby: true, maxPlayersPerRoom: 2 });

  const host = isHost();
  const seat = host ? 0 : 1;

  let seq = 0;
  let turn = null; // { run } set by bindTurn (host only)

  // Plans are buffered per (seq, seat) so a plan that arrives "early" (guest advanced
  // to turn N before the host did) is not lost. waitPlan(seq, seat) resolves when that
  // specific plan is present.
  const planBuf = {}; // seq -> { 0: plan, 1: plan }
  const planWaiters = {}; // `${seq}:${seat}` -> [resolve]
  const planKey = (sq, s) => sq + ':' + s;
  const waitPlan = (sq, s) =>
    new Promise((res) => {
      const got = planBuf[sq] && planBuf[sq][s];
      if (got !== undefined) return res(got);
      const k = planKey(sq, s);
      (planWaiters[k] = planWaiters[k] || []).push(res);
    });
  const deliverPlan = (sq, s, plan) => {
    (planBuf[sq] = planBuf[sq] || {})[s] = plan;
    const k = planKey(sq, s);
    (planWaiters[k] || []).forEach((fn) => fn(plan));
    planWaiters[k] = [];
  };

  // --- RPC handlers ---
  // Plan transport only: buffer the plan under its seq; the host's lockTurnNet resolves.
  RPC.register(RPC_SUBMIT, async (data) => {
    if (!host) return null;
    deliverPlan(data.seq, data.seat, data.plan);
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

  // Lobby handshake: each client RPCs its lobby slot to the host, which mirrors it
  // into shared state so BOTH clients observe the same lobby. Playroom can drop
  // RPCs sent during coin insert, so we also mirror via setState as a fallback.
  RPC.register(RPC_READY, async (data) => {
    if (!host) return null;
    setState(STATE_LOBBY, { ...getState(STATE_LOBBY), [data.slotKey]: data.value });
    return true;
  });

  const publishLobby = (slotKey, value) => {
    if (host) {
      setState(STATE_LOBBY, { ...getState(STATE_LOBBY), [slotKey]: value });
    } else {
      RPC.call(RPC_READY, { slotKey, value }, RPC.Mode.HOST).catch(() => {
        setState(STATE_LOBBY, { ...getState(STATE_LOBBY), [slotKey]: value });
      });
    }
  };

  const api = {
    seat,
    roomCode: getRoomCode(),
    isHost: host,
    onThrowRequest: null,
    onClashRequest: null,

    setSeq(n) {
      seq = n;
      // Do NOT clear planBuf: a plan for this seq may already have arrived early.
      // Prune only seqs older than the current one.
      for (const k of Object.keys(planBuf)) {
        if (Number(k) < n) delete planBuf[k];
      }
    },
    bindTurn(t) {
      turn = t;
    },

    // Resolves the first time another player joins (or immediately if one already
    // did). Used to gate the match start and to show "opponent joined" UI.
    waitForOpponent() {
      return new Promise((resolve) => {
        const off = onPlayerJoin(() => { off && off(); resolve(); });
        // onPlayerJoin fires for future joins; if the opponent is already here the
        // host's turn loop simply won't block (plans arrive via RPC). Resolve after
        // a short grace so a lone player can still see the attract screen.
        setTimeout(resolve, 1500);
      });
    },

    // --- Lobby protocol ---
    // Each seat publishes { joined, mech } under seat-0 / seat-1. The HOST mirrors
    // both slots into shared state (STATE_LOBBY), so every client sees the same
    // lobby and the match can only start when BOTH seats selected a machine.

    // Read the current lobby snapshot (or null).
    readLobby() {
      return getState(STATE_LOBBY) || null;
    },

    // Resolves as soon as `pred(lobby)` holds (polled; cheap and robust).
    waitLobby(pred, timeoutMs = 0) {
      const start = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          const l = getState(STATE_LOBBY);
          if (l && pred(l)) return resolve(l);
          if (timeoutMs && Date.now() - start > timeoutMs) return resolve(null);
          setTimeout(tick, 80);
        };
        tick();
      });
    },

    // Observe lobby changes (for lobby UI). Returns an unsubscribe fn.
    whenLobby(fn) {
      let last = '';
      const t = setInterval(() => {
        const l = getState(STATE_LOBBY);
        const sig = l ? JSON.stringify(l) : '';
        if (sig !== last) {
          last = sig;
          fn(l || {});
        }
        // keep polling; caller unsubscribes when the lobby closes
      }, 250);
      return () => clearInterval(t);
    },

    // Confirm our machine pick in the lobby and (as host) decide when to start.
    async confirmMech(mechIdx) {
      publishLobby('seat-' + seat, { joined: true, mech: mechIdx });
    },

    // Host: bump the shared start signal once both seats confirmed.
    tryStart() {
      if (!host) return;
      const l = getState(STATE_LOBBY);
      if (l && l['seat-0'] && l['seat-1'] && l['seat-0'].mech >= 0 && l['seat-1'].mech >= 0) {
        setState(STATE_START, { n: (getState(STATE_START) || { n: 0 }).n + 1 });
      }
    },

    // Both seats: wait for the host's start signal (resolves with { n }).
    waitStart(timeoutMs = 0) {
      const start = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          const st = getState(STATE_START);
          if (st && st.n) return resolve(st);
          if (timeoutMs && Date.now() - start > timeoutMs) return resolve(null);
          setTimeout(tick, 80);
        };
        tick();
      });
    },

    // Publish our plan for the current seq. Host buffers locally; guest RPCs to host.
    async submit(plan) {
      if (host) {
        deliverPlan(seq, seat, plan);
        return;
      }
      await RPC.call(RPC_SUBMIT, { seq, seat, plan }, RPC.Mode.HOST);
    },

    // Host: wait for both plans for the current seq (with a safety timeout).
    async waitBothPlans(timeoutMs = 60000) {
      const sq = seq;
      const both = Promise.all([waitPlan(sq, 0), waitPlan(sq, 1)]);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('waitBothPlans timeout seq ' + sq)), timeoutMs));
      return Promise.race([both, timeout]);
    },

    // Host: broadcast the resolved segments for the current seq.
    broadcast(segments) {
      setState(STATE_RESULT, { seq, segments });
    },

    // Guest: wait for the host's result for the current seq (poll getState to avoid
    // waitForState edge cases when the value changes across consecutive turns).
    async awaitResult(timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = getState(STATE_RESULT);
        if (r && r.seq === seq) return r.segments;
        if (Date.now() > deadline) throw new Error('awaitResult timeout for seq ' + seq);
        await new Promise((res) => setTimeout(res, 50));
      }
    },

    // Host: run the full turn with scene access. The `run` callback (from game.js)
    // handles the host's OWN sub-rounds locally; these hooks only source the GUEST's
    // (seat 1) throw direction and clash pick over RPC.
    async runHostTurn() {
      const plans = await api.waitBothPlans();
      const hooks = {
        guestThrowDir: async () => RPC.call(RPC_THROW, { seq }, RPC.Mode.OTHERS),
        guestClashPick: async () => RPC.call(RPC_CLASH, { seq }, RPC.Mode.OTHERS),
      };
      const result = await turn.run(plans, hooks);
      api.broadcast(result.segments);
      return result;
    },
  };

  // Announce our seat in the lobby as soon as the session exists.
  publishLobby('seat-' + seat, { joined: true, mech: -1 });

  return api;
}
