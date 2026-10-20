# Yamaha AV receivers (YNCA)

Control the zones of your Yamaha AV receiver from Gladys, on your local
network, without any cloud: power state, power on, standby, volume (capped),
mute, input and sound program.

> **Never tested with a real device.** This integration has never been tested
> with a real device: it was built from the ynca library and tested against a
> simulated receiver only. Feedback from owners is welcome. Unofficial
> integration, not affiliated with Yamaha.

## Which receivers

Yamaha receivers that speak **YNCA**, the network control protocol on TCP port
50000: most RX-V, RX-A (AVENTAGE), HTR and CX-A models with a network port
from about 2010 onwards, including recent MusicCast models (YNCA and
MusicCast are two protocols the same receiver may speak). The zones the
receiver has (main zone, zone 2, 3, 4) are found by themselves.

### YNCA or MusicCast?

[guim31/gladys-musiccast](https://github.com/guim31/gladys-musiccast) controls
Yamaha devices through **MusicCast**, another protocol (HTTP). This
integration speaks **YNCA**:

- your receiver is older and has no MusicCast: use this integration;
- your receiver is MusicCast (speakers, sound bars, recent receivers): both may
  work. MusicCast also covers devices that are not receivers; YNCA gives the
  sound programs, inputs and zones as the receiver names them.
- Use **one or the other** for a given receiver, not both: you would get two
  Gladys devices for the same zone, and two volume caps.

## Before you start

1. On the receiver, turn on **Network Standby** (Setup > Network > Network
   Standby, the name varies by model). Without it, a receiver in standby is
   off the network: it cannot be turned on from Gladys and shows as off.
2. Give the receiver a **fixed IP address** in your router (DHCP
   reservation). The Gladys devices are tied to this address: a new address
   gives new devices.
3. A receiver accepts few YNCA connections at a time. If another program
   keeps one open (Home Assistant `yamaha_ynca`, a script), the integration
   may not get an answer: the integration status then says so.

## Configuration

- **IP addresses of the receivers**: separated by commas, for example
  `192.168.1.50, 192.168.1.51`. Port 50000 by default; another port is written
  `192.168.1.50:50001`. Ten receivers at most.
- **Volume cap (dB)**: the highest volume Gladys may set, from -80 to +16.5 dB,
  as shown on the receiver's display. Default -20 dB.

Save: one device per zone appears in the **Discovery** tab (for example
"RX-V673 Main zone", "RX-V673 Zone 2", or the zone name set on the receiver).
Create the ones you want.

## What each device does

| Feature       | What it does                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Power         | Read only: 1 on, 0 in standby (or receiver unreachable).                                                                                     |
| Power on      | Button: turns the zone on.                                                                                                                   |
| Standby       | Button: puts the zone in standby.                                                                                                            |
| Volume        | 0 to 100, capped (see below).                                                                                                                |
| Mute          | Button: each press mutes or unmutes (the current mute is read first).                                                                        |
| Input         | Dropdown: the inputs of the receiver (with the names set on it), and "Main Zone Sync" for zones 2 to 4.                                      |
| Sound program | Dropdown, main zone only: Hall in Munich, Standard, 7ch Stereo... A program your model lacks is refused by the receiver, and Gladys says so. |

Power is a read-only state and two buttons, never a switch: an "everything
off" from a voice assistant or a scene never turns your receiver on or off by
surprise.

Changes made on the receiver, its remote or its app are pushed to Gladys at
once (at most once a second per zone).

## The volume and its cap

YNCA works in dB, from -80.5 dB to +16.5 dB in steps of 0.5 dB. Gladys shows
0 to 100, linearly: **0 = -80.5 dB, 50 = -32 dB, 100 = +16.5 dB**.

- A volume asked from Gladys (dashboard, scene, voice assistant) above the cap
  is set to the cap, not refused: "volume 80" gives the cap.
- The receiver's own volume limit (its "Max Volume" setting) also caps, when
  it is lower.
- **Unmuting** from Gladys lowers a volume above the cap to the cap first.
- **Power on** from Gladys: if the zone wakes up above the cap (its initial
  volume setting), the volume is brought back to the cap; when the receiver
  is slow to wake up, this is checked again every 2.5 s, six times.
- A volume set on the receiver itself (knob, remote, app) above the cap is
  shown as it is, and not lowered while it plays.

## Commands and answers

Every command is answered to Gladys within 4 seconds:

- done: the receiver confirmed it;
- "Refused by the receiver (@RESTRICTED)": the receiver does not accept it now
  (zone in standby, program not available on this model);
- "Sent, without confirmation": it was sent but the receiver did not confirm;
  the state shown follows what the receiver actually does;
- "... nothing sent": the receiver is not connected, or the command waited
  too long behind others; it is never sent late.

Standby and mute go before the commands waiting for the same receiver.

## When the receiver does not answer

The connection is opened again after 10 s, then at intervals doubled up to 5
minutes. Its zones show power 0, and the integration status names it. The
**Check the receivers** button gives the state of each receiver: connected or
not, model, and power, volume and input of each zone.

## Limits

- One device per zone, tied to the receiver's address (YNCA gives no serial
  number).
- No playback control (play, pause, next) of the network sources, no tuner
  presets, no scenes, no Zone B, no pure direct in this version.
- Typed addresses only: no automatic search.
- Never tested with a real device.

## Credits

The YNCA protocol is ported from the [ynca](https://github.com/mvdwetering/ynca)
library by Michel van de Wetering (MIT), the one behind the `yamaha_ynca`
Home Assistant integration. Unofficial integration, not affiliated with Yamaha.
Yamaha, AVENTAGE and MusicCast are trademarks of Yamaha Corporation.
