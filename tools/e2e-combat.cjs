// Combat integration test: forces grab and clash scenarios in an online match and
// verifies both clients stay in sync (HP + positions) after resolution.
// Run: node tools/e2e-combat.cjs
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

  log('opening host');
  const host = await makePage('host');
  await host.page.goto(`${BASE}/play?mode=net&gameId=${GAME_ID}&debug=1`, { waitUntil: 'commit' });
  await sleep(4000);
  const hs = await host.page.locator('#net-status').textContent().catch(() => null);
  const m = /Room ([A-Z0-9]+)/.exec(hs || '');
  if (!m) { log('FAILED no room', hs); await browser.close(); process.exit(1); }
  const room = m[1];
  log('room:', room);

  const guest = await makePage('guest');
  await guest.page.goto(`${BASE}/play?mode=net&gameId=${GAME_ID}&r=${room}&debug=1`, { waitUntil: 'commit' });
  await sleep(5000);

  for (let i = 0; i < 15; i++) {
    const ready = await Promise.all([
      host.page.evaluate(() => typeof window.__forcePlan === 'function').catch(() => false),
      guest.page.evaluate(() => typeof window.__forcePlan === 'function').catch(() => false),
    ]);
    if (ready[0] && ready[1]) { log('both ready'); break; }
    await sleep(800);
  }

  const info = async (p) => p.evaluate(() => window.__sceneInfo && window.__sceneInfo()).catch(() => null);

  // Poll both pages; whenever either shows a throw/clash UI, answer it.
  const answerSubRounds = async (rounds = 20, throwDir = 'E', clashPick = 'thrust') => {
    for (let k = 0; k < rounds; k++) {
      const [hi, gi] = await Promise.all([info(host.page), info(guest.page)]);
      if (hi && hi.ph === 'throw') await host.page.evaluate((d) => window.__forceThrow && window.__forceThrow(d), throwDir).catch(() => {});
      if (gi && gi.ph === 'throw') await guest.page.evaluate((d) => window.__forceThrow && window.__forceThrow(d), throwDir).catch(() => {});
      if (hi && hi.ph === 'clash') await host.page.evaluate((p) => window.__forceClash && window.__forceClash(p), clashPick).catch(() => {});
      if (gi && gi.ph === 'clash') await guest.page.evaluate((p) => window.__forceClash && window.__forceClash(p), clashPick).catch(() => {});
      await sleep(300);
    }
  };

  const force = async (p, units, plan) => {
    await p.evaluate(({ units, plan }) => {
      if (window.__forceState) window.__forceState(units);
      if (window.__forcePlan) window.__forcePlan(plan);
    }, { units, plan }).catch(() => {});
  };

  // Wait until both clients are in the choose phase (ready to lock a plan).
  const waitChoose = async (maxMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const [hi, gi] = await Promise.all([info(host.page), info(guest.page)]);
      if (hi && gi && hi.ph === 'choose' && gi.ph === 'choose') return true;
      await sleep(200);
    }
    return false;
  };

  // --- Scenario 1: GRAB (host grabs guest; host must pick throw direction) ---
  log('=== GRAB scenario ===');
  await waitChoose();
  await force(host.page, [{ x: 5, y: 10, fc: 'E' }, { x: 6, y: 10, fc: 'W' }], { a: 'grab', d: 'E' });
  await force(guest.page, [{ x: 5, y: 10, fc: 'E' }, { x: 6, y: 10, fc: 'W' }], { a: 'wait' });
  await answerSubRounds(24, 'E');
  await sleep(2000);
  let hi = await info(host.page), gi = await info(guest.page);
  log('after grab: host', JSON.stringify(hi), '| guest', JSON.stringify(gi));
  if (hi && gi) {
    if (JSON.stringify(hi.hp) !== JSON.stringify(gi.hp)) log('*** GRAB HP DESYNC ***');
    if (JSON.stringify(hi.us) !== JSON.stringify(gi.us)) log('*** GRAB POS DESYNC ***');
    else log('grab: positions in sync');
  }

  // --- Scenario 2: CLASH (both vslash toward each other) ---
  log('=== CLASH scenario ===');
  await waitChoose();
  await force(host.page, [{ x: 4, y: 10, fc: 'E' }, { x: 6, y: 10, fc: 'W' }], { a: 'vslash', d: 'E' });
  await force(guest.page, [{ x: 4, y: 10, fc: 'E' }, { x: 6, y: 10, fc: 'W' }], { a: 'vslash', d: 'W' });
  await answerSubRounds(24, 'E', 'thrust');
  await sleep(2000);
  hi = await info(host.page); gi = await info(guest.page);
  log('after clash: host', JSON.stringify(hi), '| guest', JSON.stringify(gi));
  if (hi && gi) {
    if (JSON.stringify(hi.hp) !== JSON.stringify(gi.hp)) log('*** CLASH HP DESYNC ***');
    else log('clash: HP in sync');
  }

  if (errors.length) { log('ERRORS:'); errors.forEach((e) => console.log('   ', e)); }
  else log('no fatal errors');

  await browser.close();
  log('done');
})().catch((e) => { console.error(e); process.exit(1); });
