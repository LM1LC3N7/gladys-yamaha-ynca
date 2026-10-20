# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Yamaha AV receivers over their local YNCA protocol (TCP 50000), without any
  cloud: added by IP address, one Gladys device per zone (main zone, zones 2,
  3 and 4, found by themselves).
- Power state (read only), "Power on" and "Standby" buttons, volume (0 to 100
  for -80.5 to +16.5 dB, validated strictly), mute (each press reads the mute
  and sets the opposite), an "Input" dropdown with the input names set on the
  receiver, and a "Sound program" dropdown on the main zone.
- Volume cap `max_volume_db` (-20 dB by default), read just before each
  volume is sent, together with the receiver's own limit; unmuting and Power
  on bring a higher volume back to the cap.
- Changes made on the receiver, its remote or its app are pushed to Gladys
  (grouped, at most once a second per zone).
- Every command is answered within 4 seconds: confirmed, refused by the
  receiver, "sent, without confirmation" (after a read-back), or "nothing
  sent"; a command still waiting at its deadline is dropped, never sent late.
  Mute goes before the commands waiting; Standby never waits behind them.
- A receiver off the network shows its zones at power 0 and is named in the
  status; the connection is opened again after 10 s, then at intervals
  doubled up to 5 minutes. A port held by another YNCA client is said.
- "Check the receivers" button.

### Fixed

- Power on confirmed late (a receiver slow to wake up) still brings a volume
  above the cap back to it.
- A late refusal of the receiver is no longer given to the next command,
  which was reported "refused" although done.
- Standby no longer waits behind a slow command (it was dropped, "nothing
  sent"); the command running for that zone stops writing.
- A line pushed by the receiver before the answer of a write (another input
  chosen on the remote) is no longer taken for that answer.
- Two addresses giving the same device ids (`amp.lan` and `amp-lan`) are
  refused instead of sharing devices.
- A zone appears only once the receiver reports it available, not on any
  line naming it.
- "Main Zone Sync" no longer shows in the inputs of the main zone.

### Security

- Lines are bounded (512 bytes, 4 KB without an end of line closes the
  connection), parsed linearly, and only known zones, functions and values
  are kept; a connection flooded with lines is closed. Only fixed values or
  formatted numbers are ever sent, 100 ms apart.

[Unreleased]: https://github.com/LM1LC3N7/gladys-yamaha-ynca/commits/main
