# Third-party notices

This integration ports to JavaScript the logic of the following project: the
YNCA line protocol (`@<SUBUNIT>:<FUNCTION>=<value>` ended by CR LF, `?` to
read, `@UNDEFINED` / `@RESTRICTED`, the parsing of a line), the 100 ms spacing
between commands, the keep-alive (`@SYS:MODELNAME=?` every 30 s, twice on
connecting), the detection of the zones and input subunits (`AVAIL`), the
snapshot ended by `@SYS:VERSION=?`, the zone functions used (`BASIC`, `PWR`,
`VOL`, `MAXVOL`, `MUTE`, `INP`, `SOUNDPRG`, `ZONENAME`), the volume range and
step, and the values of the inputs, sound programs, power and mute
(`src/ynca/`). Nothing of it is installed at runtime; its notice is reproduced
below.

## ynca 6.2.1

<https://github.com/mvdwetering/ynca> (the library behind the
`yamaha_ynca` Home Assistant custom integration), version `6.2.1` of
2026-08-23

```
MIT License
Copyright (c) 2017 Michel van de Wetering

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## LM1LC3N7/gladys-cambridge-audio and LM1LC3N7/gladys-denon-avr

The structure of the app, the command queue and budget, the volume cap, the
`/data` store and the handler wiring follow integrations of the same author,
under the Apache License 2.0 of this repository.
