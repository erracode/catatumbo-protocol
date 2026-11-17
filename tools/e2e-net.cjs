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
  await sleep(4000);
  const hostStatus = await host.page.locator('#net-status').textContent().catch(() => null);
  const m = /Room ([A-Z0-9]+)/.exec(hostStatus || '');
  if (!m) { log('FAILED: no room code', hostStatus); await browser.close(); process.exit(1); }
  const room = m[1];
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
