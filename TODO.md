# TODO — Yamaha YNCA v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-20): receivers added by IP
      address, one persistent YNCA connection each (snapshot, pushed lines,
      keep-alive, spaced reconnection), one Gladys device per zone; power
      state, power on, standby, volume capped by `max_volume_db`, mute, input
      and sound program dropdowns; "Check" button; docs en/fr. Tested against
      a fake receiver on the loopback interface only, never with a real
      device. The store validator could not be run from the development
      session (no access to it there): to run before the first release.
- [ ] **Milestone 2 — real receivers** (testers with an RX-V, RX-A or HTR). To
      check first:
  - whether a write of an unchanged value is answered (today: no answer is
    read back, then "sent, without confirmation" if still unknown);
  - which answer a write gets in standby (`@RESTRICTED`?), and whether
    `VOL` can be read in standby;
  - how many YNCA connections a receiver accepts at once, and what a second
    client sees (today: "port held by another client" when the connection
    opens but nothing answers);
  - `BASIC` on zones 2 to 4 (does it give `SOUNDPRG`, `INP`?), `MAXVOL`
    values, `ZONENAME` length;
  - the input names (`@SYS:INPNAME…`) and the inputs not listed there
    (`AUDIO`, `TV`, `OPTICAL1`...): today added to the dropdown when a zone
    shows them;
  - the encoding of the names (read as UTF-8 today);
  - the rendering on the Gladys dashboard: `music/volume`,
    `television/volume-mute` press, the two `button/push`, `unknown/binary`
    power, the two `text/select`.
- [ ] **Milestone 3 — more**: playback of the network sources (`PLAYBACK` of
      the input subunit), tuner presets, scenes (`SCENE`), Zone B
      (`ZONEBVOL`, `PWRB`), pure direct / straight, volume up/down buttons,
      SSDP discovery (the serial number of the UPnP description as a stable
      id), a "forget a receiver" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: mvdwetering/ynca 6.2.1 (MIT, 2026-08-23, the library of the
  `yamaha_ynca` Home Assistant integration) is Python (pyserial, threads), so
  its protocol is ported to JavaScript (`src/ynca/`) on `node:net`: line
  format and parsing, 100 ms spacing, keep-alive, `AVAIL` detection, snapshot
  ended by `@SYS:VERSION=?`, zone functions, volume range, input and sound
  program values. MIT notice in `THIRD_PARTY_NOTICES.md`, copied into the
  image. No runtime dependency besides the SDK. Serial (RS-232) is out: TCP
  only.
- Distinct from guim31/gladys-musiccast (MusicCast HTTP protocol): said in
  the manifest, README and docs (use one or the other for a given receiver).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('ynca', '<address slug>-<zone>')`, for
  example `192-168-1-50-main` (`192-168-1-50-50001-zone2` on another port).
  YNCA gives no serial number, so the typed address is the identity (said in
  the docs: keep it fixed). Feature keys are frozen: `power`, `power_on`,
  `standby`, `volume`, `mute`, `source`, and `sound_program` on the main zone
  only. Every publication carries the full, fixed feature list of the zone (a
  device published again never loses a feature); only the input options grow
  (merged with the `supported_options` of the created devices).
- Zones: the ones that answer `@<ZONE>:AVAIL=?`, kept in /data and never
  dropped, so a receiver off at start still has its devices. (Review 1,
  2026-10-21) Any other line of a zone not seen with AVAIL is ignored, never
  creates it.
- (Review 1) Two typed addresses with the same slug (`amp.lan` / `amp-lan`,
  `192.168.1.50` / `192-168-1-50`) would share external ids: the second is
  refused (listed as invalid in the status).
- (Review 1) "Main Zone Sync" is never kept in the input list shared by the
  zones: `inputOptions()` adds it for zones 2 to 4 only.
- **Power: read-only state + two `button/push`, not a `switch`.** Lesson of
  lot 6: an "everything on / off" must not wake a receiver up nor cut it.
  `PWR=On` / `PWR=Standby` per zone.
- **Volume cap** (`max_volume_db`, -80..+16.5 dB, default -20 dB, on the 0.5
  step): in dB as the receiver shows it, more meaningful than a percentage.
  The feature stays 0..100 (frozen at creation), linear on -80.5..+16.5 dB.
  A higher volume is set to the cap (clamped, logged), not refused. The cap
  is read inside the queued task, just before the line leaves; the zone's own
  `MAXVOL`, when read and lower, caps too. A volume set on the receiver above
  the cap is shown, not lowered while it plays, except by the two commands of
  Gladys that would make it heard:
  - unmute: `MUTE` then `VOL` read again; above the cap, `VOL=<cap>` is sent
    first, then `MUTE=Off`; volume unknown: refused, "nothing sent";
  - Power on: after `PWR=On`, `VOL` is read and lowered to the cap when above
    it; when the zone cannot tell yet, checked again every 2.5 s, 6 times at
    most, through the receiver queue (the ack never depends on it); one chain
    per zone, a new Power on restarts it. (Review 1) Also when `PWR=On` was
    sent but confirmed late or not at all (a receiver slow to wake up): only a
    refusal, or nothing sent, starts no check.
- Mute is a push: the mute is read just before and the explicit `On` / `Off`
  set, never a toggle. `Att -20 dB` / `Att -40 dB` count as muted.
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Input: the select values are the YNCA input values (`HDMI1`, `NET RADIO`,
  `Main Zone Sync` for zones 2 to 4), labels the names set on the receiver.
  Only values of the fixed table of ynca are ever kept or sent. Sound
  program: the fixed list of ynca for every main zone (a model without a
  program answers `@RESTRICTED`, reported "Refused by the receiver").
- Commands: serialized per receiver (one connection), budget 3.5 s from the
  Gladys request (the wait in the queue included), each answer awaited 1.2 s
  at most; a command still queued at its deadline is dropped, never sent
  late. A write is confirmed only by a line of the same function carrying
  the value it set (review 1: a line pushed meanwhile with another value is
  not its answer); without one, read back; still unknown: "sent, without
  confirmation"; read back with another value: "sent; the receiver reports
  …". Mute goes before the commands waiting, never before the one running.
- (Review 1) Answers matched in order: every line written on a session
  (keep-alive and snapshot included) is kept in a FIFO until answered. A
  refusal line (`@RESTRICTED`, `@UNDEFINED`) belongs to the oldest one; a
  line whose waiter timed out stays as a tombstone (5 s or 64 lines at most)
  and takes its late refusal, so a late refusal is never given to the next
  command. An `ok` line goes to the oldest live waiter of its function that
  accepts its value (the older lines no longer waited for are dropped), else
  to the oldest tombstone of its function.
- (Review 1) **Standby never waits in the queue**: sent at once on the
  connection (at most one line spacing behind the line in flight), with its
  own 3.5 s budget; it cancels the wake-up check of the zone, and the command
  running for that zone writes nothing more ("Standby pressed: … not sent").
- Connection: one TCP connection per typed address, kept across
  reconnections to Gladys (`connected` only clears the status cache and
  `forgetPublishedStates`, then republishes the status, the devices and the
  states). Reconnection after 10 s, doubled after each failure up to 5
  minutes; the count is only reset by a connection that stayed up 60 s. A
  configuration save asks for a reconnection, never sooner than 10 s after
  the last attempt; a reconnection to Gladys does not. Keep-alive
  `@SYS:MODELNAME=?` every 30 s (the receiver drops an idle connection after
  40 s); no line in 45 s closes the connection. Not persisted in /data: no
  rate limit nor credential to protect.
- Reachability: a failed attempt is "off without network standby, or
  unreachable": power 0, named in the status. A connection that opens but
  never completes the snapshot is reported as "port held by another YNCA
  client" (Home Assistant...). The status stays "connected" (local
  integration, no account).
- Hostile input: 512 bytes per line (longer ones dropped), 4 KB without an end
  of line closes the connection, linear parsing (two `indexOf`), subunit and
  function names `[A-Z0-9]` only, values kept only when known (inputs, sound
  programs, power, mute) or numbers in range; names cleaned (control and bidi
  characters) and cut to 64 characters; more than 600 lines in 10 s closes
  the connection. Lines sent: fixed values or formatted numbers, printable
  ASCII without `@` nor line break (checked again by `formatLine`), 64 at
  most waiting. The receiver table of /data has no prototype and is checked
  again when read.
- Publication: grouped per zone (at most one `publishChangedStates` per
  second), only the created devices.
- Categories and types from the core only (`server/utils/constants.js`):
  `music/volume`, `television/volume-mute`, `text/select`, `button/push`,
  `unknown/binary`. No unit: `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none
  for these categories. Store category `multimedia`.
- No network discovery in v1 (YNCA has none; SSDP is milestone 3).
