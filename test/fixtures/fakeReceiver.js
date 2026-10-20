// -----------------------------------------------------------------------------
// A fake YNCA receiver on the loopback interface: answers the reads the
// integration makes, applies and echoes the writes, and can push lines, stay
// silent, refuse functions or close the connection. It records every line it
// receives, with its time, for the tests.
// -----------------------------------------------------------------------------

import net from 'node:net';

export const MODEL = 'RX-V673';

export function defaultState() {
  return {
    model: MODEL,
    version: '1.80/2.01',
    zones: {
      MAIN: {
        PWR: 'On',
        VOL: '-35.0',
        MUTE: 'Off',
        INP: 'HDMI1',
        SOUNDPRG: 'Standard',
        MAXVOL: '16.5',
        ZONENAME: 'Living',
      },
      ZONE2: { PWR: 'Standby', VOL: '-40.0', MUTE: 'Off', INP: 'NET RADIO', MAXVOL: '0.0' },
    },
    inputNames: { HDMI1: 'Blu-ray', HDMI2: 'HDMI2', AV1: 'TV', MULTICH: 'MULTI CH' },
    subunits: ['NETRADIO', 'TUN', 'USB'],
  };
}

export async function startFakeReceiver(options = {}) {
  /** The options, changeable while the fake runs (`fake.cfg`). */
  const cfg = {
    state: defaultState(),
    /** Accepts the connection but never answers. */
    silent: false,
    /** Closes every connection as soon as it opens (another client holds the port). */
    closeOnConnect: false,
    /** Answers a write that changes nothing (some receivers do not). */
    echoUnchanged: true,
    /** Functions answered @RESTRICTED when written, e.g. new Set(['SOUNDPRG']). */
    restricted: new Set(),
    /** The volume a zone wakes up at (its own initial volume setting), if any. */
    wakeVolume: undefined,
    /** Delay before each answer, in ms. */
    answerDelay: 0,
    /** Writes of these functions get no answer at all (read-back still works). */
    noAnswer: new Set(),
    ...options,
  };
  const { state } = cfg;
  const lines = [];
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (cfg.closeOnConnect) {
      socket.destroy();
      return;
    }
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf('\r\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        lines.push({ line, at: Date.now() });
        if (!cfg.silent) {
          const answers = answer(line);
          const send = () => {
            if (!socket.destroyed) {
              socket.write(answers.map((a) => `${a}\r\n`).join(''));
            }
          };
          if (answers.length > 0) {
            cfg.answerDelay > 0 ? setTimeout(send, cfg.answerDelay) : send();
          }
        }
        end = buffer.indexOf('\r\n');
      }
    });
  });

  function answer(line) {
    const match = line.match(/^@([A-Z0-9]+):([A-Z0-9]+)=(.*)$/);
    if (!match) {
      return ['@UNDEFINED'];
    }
    const [, subunit, fn, value] = match;
    if (subunit === 'SYS') {
      if (value !== '?') {
        return ['@RESTRICTED'];
      }
      if (fn === 'MODELNAME') {
        return [`@SYS:MODELNAME=${state.model}`];
      }
      if (fn === 'VERSION') {
        return [`@SYS:VERSION=${state.version}`];
      }
      if (fn === 'INPNAME') {
        return Object.entries(state.inputNames).map(([k, v]) => `@SYS:INPNAME${k}=${v}`);
      }
      return ['@UNDEFINED'];
    }
    const zone = state.zones[subunit];
    if (!zone) {
      if (state.subunits.includes(subunit) && fn === 'AVAIL') {
        return [`@${subunit}:AVAIL=Ready`];
      }
      return ['@UNDEFINED'];
    }
    if (value === '?') {
      if (fn === 'AVAIL') {
        return [`@${subunit}:AVAIL=Ready`];
      }
      if (fn === 'BASIC') {
        return ['PWR', 'VOL', 'MUTE', 'INP', 'SOUNDPRG']
          .filter((k) => zone[k] !== undefined)
          .map((k) => `@${subunit}:${k}=${zone[k]}`);
      }
      return zone[fn] === undefined ? ['@UNDEFINED'] : [`@${subunit}:${fn}=${zone[fn]}`];
    }
    if (cfg.restricted.has(fn)) {
      return ['@RESTRICTED'];
    }
    if (!['PWR', 'VOL', 'MUTE', 'INP', 'SOUNDPRG'].includes(fn)) {
      return ['@UNDEFINED'];
    }
    const changed = zone[fn] !== value;
    zone[fn] = value;
    const out = changed || cfg.echoUnchanged ? [`@${subunit}:${fn}=${value}`] : [];
    if (cfg.noAnswer.has(fn)) {
      return [];
    }
    if (fn === 'PWR' && value === 'On' && changed && cfg.wakeVolume !== undefined) {
      zone.VOL = cfg.wakeVolume;
      out.push(`@${subunit}:VOL=${cfg.wakeVolume}`);
    }
    return out;
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    cfg,
    lines,
    get connections() {
      return connections;
    },
    /** Lines received that are not reads (`?`). */
    writes: () => lines.map((l) => l.line).filter((l) => !l.endsWith('=?')),
    push(text) {
      for (const socket of sockets) {
        socket.write(`${text}\r\n`);
      }
    },
    raw(text) {
      for (const socket of sockets) {
        socket.write(text);
      }
    },
    dropClients() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
