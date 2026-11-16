# Catatumbo Protocol

A simultaneous-turn mecha duel over Lake Maracaibo. Both pilots commit their moves
in secret, then watch the clash resolve at once. Originally built for the
**Platanus Hack 26 — Arcade Challenge** (Caracas); now a standalone web game with
online multiplayer.

## Stack

- **Astro** — static site (landing + game island)
- **Phaser 3** — rendering and game loop
- **Playroom Kit** — online multiplayer (host-authoritative, up to 8 players)

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
npm test         # turn-resolver smoke tests
```

## Play modes

- **vs CPU** — `/play` (single-player gauntlet)
- **Online 2P** — `/play?mode=net&gameId=YOUR_ID` (needs a free Playroom gameId)

## Architecture

- `src/game/game.js` — all rules, rendering, and the scene. The rules engine is pure
  (`resolveFullTurn`), so the same turn resolves identically on any client.
- `src/game/net.js` — Playroom adapter. The host resolves each turn and broadcasts
  the event stream; every client replays it. Zero desync, secret plans.
- `src/pages/` — landing and the play island.

## Credits

Built for the Platanus Hack 26 arcade challenge. Mecha duel, simultaneous turns,
Lake Maracaibo.
