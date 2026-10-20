# Gladys Assistant — Yamaha AV receivers (YNCA)

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls Yamaha AV receivers (RX-V, RX-A, HTR...) over **YNCA**, their local
network control protocol (TCP 50000), without any cloud.

- One Gladys device per zone (main zone, zones 2, 3 and 4, found by
  themselves).
- Power state (read only), "Power on" and "Standby" buttons, volume, mute,
  input dropdown, sound program dropdown (main zone).
- **Volume capped** by an option in dB (-20 dB by default), also when
  unmuting and after Power on.
- Changes made on the receiver are pushed to Gladys at once.

**Never tested with a real device.** Unofficial integration, not affiliated
with Yamaha.

Not to be confused with
[guim31/gladys-musiccast](https://github.com/guim31/gladys-musiccast), which
speaks **MusicCast** (another protocol). A recent receiver may speak both: use
one integration or the other for it. See the guide.

## Documentation

- [Guide in English](docs/en.md)
- [Guide en français](docs/fr.md)

## Development

```bash
npm install
npm test               # node --test, against a fake receiver on the loopback interface
npm run lint
npm run format:check
npm run cover          # regenerates cover.png (800×534)
npx github:GladysAssistant/integration-store .
```

Architecture, rules and decisions: [CLAUDE.md](CLAUDE.md) and
[TODO.md](TODO.md).

## Credits

The YNCA protocol logic is ported from
[ynca](https://github.com/mvdwetering/ynca) by Michel van de Wetering (MIT),
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Yamaha, AVENTAGE and
MusicCast are trademarks of Yamaha Corporation.

## License

[Apache License 2.0](LICENSE).
