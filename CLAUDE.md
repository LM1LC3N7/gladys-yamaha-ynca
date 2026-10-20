# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Yamaha AV receivers, over their
local YNCA protocol (TCP 50000): a Node.js service (Node 22+, ESM, no build
step) that runs in its own sandboxed Docker container and talks to Gladys
through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its only runtime dependency is the SDK. It started from the official
JavaScript template; the protocol logic is ported from the `ynca` Python
library (MIT, see `THIRD_PARTY_NOTICES.md`). Decisions are recorded in
`TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "volume"  # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> YncaApp (shared with the tests)
src/app.js                        receivers, zones, commands and volume cap, button, status
src/ynca/link.js                  one receiver: TCP session, snapshot, pushed lines, keep-alive, reconnection
src/ynca/connection.js            one TCP session: bounded lines in, spaced lines out
src/ynca/protocol.js              YNCA lines, values, volume conversions (pure)
src/model.js                      receivers -> Gladys devices (one per zone) and states (pure)
src/store.js                      /data/yamaha-ynca.json
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys + fake YNCA receiver (test/fixtures/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`. YNCA gives no serial number: the
  platform id is the typed address and the zone (`192-168-1-50-main`). Gladys
  keys devices, their history, scenes and dashboards on them: changing the
  scheme creates new devices and orphans the old ones. The same goes for every
  key users store: manifest `config_schema`, `actions`, feature keys.
- **The volume cap is a safety rule.** Every volume sent goes through the cap
  read just before sending; never add a path (scene action, widget, volume
  up) that bypasses it.
- **No switch** for power: an "everything on / off" must not command a
  receiver. Buttons and read-only states only.
- **Only known values are sent.** Inputs and sound programs come from the
  fixed tables of `src/ynca/protocol.js`; `formatLine` refuses anything else.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
