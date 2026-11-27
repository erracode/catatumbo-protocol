// Integration test: host creates a room, guest joins, and they play several turns.
// Uses the ?debug=1 window.__forcePlan hook for deterministic plans (no fragile input).
// Verifies both clients stay on the same state (HP) after each resolved turn.
// Run: node tools/e2e-net.cjs
const { chromium } = require('playwright');

const GAME_ID = process.env.GAME_ID || '9zfQpYpu1MrPWjldLTfD';
const BASE = process.env.BASE_URL || 'http://localhost:4321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  const makePage = async (label) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (t.startsWith('[net]')) console.log(`  [${label}] ${t}`);
      if (m.type() === 'error' && !t.includes('ReactDOM.render')) errors.push(`[${label}] ${t}`);
    });
    page.on('pageerror', (e) => { if (!e.message.includes('Framebuffer')) errors.push(`[${label}] PAGEERROR ${e.message}`); });
    return { ctx, page };
  };

  log('opening host (creates room)');
  const host = await makePage('host');
  await host.page.goto(`${BASE}/play?mode=net&gameId=${GAME_ID}&debug=1`, { waitUntil: 'commit' });
  // Playroom writes the room code into the URL hash as `#r=R<code>` and the
  // status chip clears as soon as the match mounts, so the URL is the reliable
  // source. The leading `R` in the hash is a display prefix: the canonical room
  // code (what getRoomCode() returns and what `?r=` must carry) excludes it.
  let room = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const hm = /[#&?]r=R([A-Za-z0-9]+)/.exec(host.page.url());
    if (hm) { room = hm[1]; break; }
  }
  if (!room) { log('FAILED: no room code', host.page.url()); await browser.close(); process.exit(1); }
  log('room:', room);

  log('opening guest (joins room)');
  const guest = await makePage('guest');
  await guest.page.goto(`${BASE}/play?mode=net&gameId=${GAME_ID}&r=${room}&debug=1`, { waitUntil: 'commit' });
  await sleep(5000);

  // Wait for both canvases + debug hooks.
  for (let i = 0; i < 15; i++) {
    const ready = await Promise.all([
      host.page.evaluate(() => typeof window.__forcePlan === 'function').catch(() => false),
      guest.page.evaluate(() => typeof window.__forcePlan === 'function').catch(() => false),
    ]);
    if (ready[0] && ready[1]) { log('both scenes ready'); break; }
    await sleep(800);
  }

  const info = async (p) => p.evaluate(() => window.__sceneInfo && window.__sceneInfo()).catch(() => null);
  log('host info:', JSON.stringify(await info(host.page)));
  log('guest info:', JSON.stringify(await info(guest.page)));

  // Lobby: both seats lock a machine; the start fires automatically once both do.
  log('lobby: confirming machines');
  for (let i = 0; i < 20; i++) {
    const ok = await Promise.all([
      host.page.evaluate(() => typeof window.__lobby === 'function').catch(() => false),
      guest.page.evaluate(() => typeof window.__lobby === 'function').catch(() => false),
    ]);
    if (ok[0] && ok[1]) break;
    await sleep(800);
  }
  await host.page.evaluate(() => window.__lobby && window.__lobby(0)).catch(() => {});
  await guest.page.evaluate(() => window.__lobby && window.__lobby(2)).catch(() => {});
  await sleep(6000); // lobby handshake + start signal + match intro

  // Play 4 turns: force a wait plan on both, then wait for resolution.
  for (let t = 0; t < 4; t++) {
    await host.page.evaluate(() => window.__forcePlan && window.__forcePlan({ a: 'wait' })).catch(() => {});
    await guest.page.evaluate(() => window.__forcePlan && window.__forcePlan({ a: 'wait' })).catch(() => {});
    await sleep(4000);
    const hi = await info(host.page);
    const gi = await info(guest.page);
    log(`after turn ${t}: host rt=${hi && hi.rt} hp=${hi && hi.hp} | guest rt=${gi && gi.rt} hp=${gi && gi.hp}`);
    if (hi && gi && JSON.stringify(hi.hp) !== JSON.stringify(gi.hp)) {
      log('*** HP DESYNC DETECTED ***');
    }
  }

  if (errors.length) { log('ERRORS:'); errors.forEach((e) => console.log('   ', e)); }
  else log('no fatal errors');

  await browser.close();
  log('done');
})().catch((e) => { console.error(e); process.exit(1); });
