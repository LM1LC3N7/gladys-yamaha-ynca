// -----------------------------------------------------------------------------
// The persistent link with the receiver at one address: the TCP session
// opened, the snapshot read (model, zones, inputs, then power, volume, mute,
// input and sound program of each zone, as ynca's initialize()), the pushed
// lines merged, a keep-alive every 30 s, and the reconnection spaced out (10 s,
// then doubled each time up to 5 minutes; the count is only reset by a
// connection that stayed up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, TIMINGS, ZONES } from '../constants.js';
import { DeviceError, ERROR_KINDS, openSession } from './connection.js';
import {
  SUBUNIT_INPUTS,
  cleanText,
  getLine,
  formatLine,
  inputOfInpname,
  isInput,
  isSoundProgram,
  parseDb,
  parseLine,
  parseMute,
  parsePower,
} from './protocol.js';

const ZONE_SET = new Set(ZONES);
/** A line written and never answered is forgotten after this. */
const TOMBSTONE_MS = 5_000;
const INPUT_SUBUNITS = new Set(Object.keys(SUBUNIT_INPUTS));

export const emptyState = () => ({
  model: undefined,
  /** zone -> { power, volume (dB), mute, input, soundProgram, maxVolume (dB), name } */
  zones: Object.create(null),
  /** The input subunits that answered `AVAIL` (their inputs exist). */
  inputSubunits: new Set(),
  /** input -> name given on the receiver (`@SYS:INPNAME…`). */
  inputNames: new Map(),
});

/** The lines of the snapshot, in order (the end marker last). */
export function snapshotLines() {
  return [
    // A receiver in low power mode loses the first line (ynca sends two keep-alives).
    getLine('SYS', 'MODELNAME'),
    getLine('SYS', 'MODELNAME'),
    ...ZONES.map((zone) => getLine(zone, 'AVAIL')),
    ...[...INPUT_SUBUNITS].map((subunit) => getLine(subunit, 'AVAIL')),
    getLine('SYS', 'INPNAME'),
    ...ZONES.flatMap((zone) => [
      getLine(zone, 'BASIC'),
      getLine(zone, 'MAXVOL'),
      getLine(zone, 'ZONENAME'),
    ]),
    // The end marker (ynca uses it the same way).
    getLine('SYS', 'VERSION'),
  ];
}

/**
 * Applies one parsed `ok` line to `state`. Returns the zone it changed, 'SYS'
 * for the model or the inputs, or undefined when nothing kept changed.
 */
export function applyLine(state, { subunit, fn, value }) {
  if (subunit === 'SYS') {
    if (fn === 'MODELNAME') {
      const model = cleanText(value, LIMITS.name);
      if (model && model !== state.model) {
        state.model = model;
        return 'SYS';
      }
      return undefined;
    }
    const input = inputOfInpname(fn);
    if (input) {
      const name = cleanText(value, LIMITS.name) ?? input;
      if (state.inputNames.get(input) !== name && state.inputNames.size < LIMITS.inputs) {
        state.inputNames.set(input, name);
        return 'SYS';
      }
    }
    return undefined;
  }
  if (INPUT_SUBUNITS.has(subunit)) {
    if (fn === 'AVAIL' && !state.inputSubunits.has(subunit)) {
      state.inputSubunits.add(subunit);
      return 'SYS';
    }
    return undefined;
  }
  if (!ZONE_SET.has(subunit)) {
    return undefined;
  }
  // A zone exists only once it answered AVAIL (as ynca): any other line of a
  // zone not seen yet is ignored, never creates it.
  if (!state.zones[subunit]) {
    if (fn !== 'AVAIL') {
      return undefined;
    }
    state.zones[subunit] = {};
    return subunit;
  }
  const zone = state.zones[subunit];
  const before = JSON.stringify(zone);
  switch (fn) {
    case 'AVAIL':
      break;
    case 'PWR':
      zone.power = parsePower(value);
      break;
    case 'VOL':
      zone.volume = parseDb(value);
      break;
    case 'MAXVOL':
      zone.maxVolume = parseDb(value);
      break;
    case 'MUTE':
      zone.mute = parseMute(value);
      break;
    case 'INP':
      zone.input = isInput(value) ? value : undefined;
      break;
    case 'SOUNDPRG':
      zone.soundProgram = isSoundProgram(value) ? value : undefined;
      break;
    case 'ZONENAME':
      zone.name = cleanText(value, LIMITS.name);
      break;
    default:
      return undefined;
  }
  return JSON.stringify(zone) === before ? undefined : subunit;
}

export class ReceiverLink {
  constructor({
    address,
    onEvent = () => {},
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = Date.now,
    createSocket,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.createSocket = createSocket;
    this.session = undefined;
    this.connecting = false;
    this.stopped = false;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttempt = -Infinity;
    this.lastLineAt = 0;
    this.retryTimer = undefined;
    this.keepAliveTimer = undefined;
    this.lines = [];
    /**
     * Every line written on the current session and not answered yet, in
     * order: { subunit, fn, at, waiter }. The receiver answers in order, so a
     * refusal (`@RESTRICTED`, `@UNDEFINED`) belongs to the oldest one. A
     * waiter that timed out stays as a tombstone (`waiter.done`) until its
     * late answer comes (or `TOMBSTONE_MS` / `LIMITS.sentLines`), so a late
     * answer is never given to the next line.
     */
    this.sent = [];
    /** The end marker of the snapshot. */
    this.snapshotDone = undefined;
    /** The last error of a connection attempt (shown by "Check"). */
    this.lastError = undefined;
    /** A connection that opened, then closed at once or never answered: another client may hold the port. */
    this.busyHint = false;
    this.state = emptyState();
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  get connected() {
    return Boolean(this.session?.open) && this.connectedAt !== undefined;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopKeepAlive();
    const session = this.session;
    this.session = undefined;
    session?.close();
    this.settleWaiters({ closed: true });
  }

  /** Writes one line on `session` and tracks it (see `this.sent`). Rejects when not written. */
  async track(session, line, waiter) {
    const parsed = parseLine(line);
    await session.send(line);
    if (session !== this.session) {
      return;
    }
    this.sent.push({ subunit: parsed.subunit, fn: parsed.fn, at: this.now(), waiter });
    this.prune();
  }

  /** Drops the entries too old or too many (the receiver will not answer them any more). */
  prune() {
    const now = this.now();
    while (
      this.sent.length > 0 &&
      (this.sent.length > LIMITS.sentLines || now - this.sent[0].at > TOMBSTONE_MS) &&
      !this.isLive(this.sent[0])
    ) {
      this.sent.shift();
    }
  }

  isLive(entry) {
    return Boolean(entry.waiter && !entry.waiter.done);
  }

  /** Resolves a live waiter once. */
  settle(waiter, result) {
    if (!waiter || waiter.done) {
      return;
    }
    waiter.done = true;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  /** A reconnection asked now (configuration saved): skips the backoff, never the base interval. */
  retrySoon() {
    if (this.stopped || this.connected || this.connecting) {
      return;
    }
    const wait = Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now());
    this.schedule(wait);
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, ms);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return Math.min(
      this.timings.reconnectMax,
      this.timings.reconnectBase * 2 ** Math.min(this.failures - 1, 16),
    );
  }

  async connect() {
    if (this.stopped || this.connecting || this.session) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let session;
    let opened = false;
    try {
      session = await openSession({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeout,
        spacing: this.timings.commandSpacing,
        createSocket: this.createSocket,
        onLine: (line) => this.receive(session, line),
        onClose: () => this.closed(session),
      });
      opened = true;
      if (this.stopped) {
        session.close();
        return;
      }
      this.session = session;
      this.sent = [];
      await this.readSnapshot(session);
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.busyHint = false;
      this.startKeepAlive(session);
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      // Opened, then closed or silent: the YNCA port may be held by another client.
      this.busyHint = opened;
      if (session) {
        this.session = undefined;
        session.onClose = () => {};
        session.close();
      }
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  async readSnapshot(session) {
    const state = emptyState();
    this.state = state;
    const lines = snapshotLines();
    const done = new Promise((resolve) => {
      this.snapshotDone = resolve;
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        this.timings.initBase + lines.length * this.timings.initPerCommand,
      );
    });
    // Closed while reading: the session send rejects.
    const sent = Promise.all(lines.map((line) => this.track(session, line))).then(
      () => new Promise(() => {}),
    );
    const closed = new Promise((resolve) => {
      session.onSnapshotClose = () => resolve(false);
    });
    try {
      const ok = await Promise.race([done, timeout, sent, closed]);
      if (!ok) {
        throw new DeviceError(ERROR_KINDS.PROTOCOL, 'No complete answer from the receiver');
      }
    } finally {
      clearTimeout(timer);
      this.snapshotDone = undefined;
      session.onSnapshotClose = undefined;
    }
    if (!state.model) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not a YNCA receiver (no model name)');
    }
  }

  receive(session, line) {
    if (session !== this.session) {
      return;
    }
    if (this.flooded(session)) {
      return;
    }
    this.lastLineAt = this.now();
    const parsed = parseLine(line);
    if (!parsed) {
      return;
    }
    this.prune();
    if (parsed.status !== 'ok') {
      // A refused line: the oldest one written (the receiver answers in order).
      // A tombstone takes it: a late refusal never reaches the next line.
      const entry = this.sent.shift();
      this.settle(entry?.waiter, { refused: parsed.status });
      return;
    }
    const changed = applyLine(this.state, parsed);
    if (parsed.subunit === 'SYS' && parsed.fn === 'VERSION' && this.snapshotDone) {
      this.snapshotDone(true);
    }
    this.answer(parsed);
    if (changed && this.connectedAt !== undefined) {
      this.onEvent('update', this, changed);
    }
  }

  /** Every line counts, before parsing: a receiver flooding the connection is closed. */
  flooded(session) {
    const now = this.now();
    this.lines.push(now);
    while (this.lines.length > 0 && now - this.lines[0] > this.timings.floodWindow) {
      this.lines.shift();
    }
    if (this.lines.length > this.timings.floodLines) {
      this.logger?.warn?.(`${this.key}: too many lines, connection closed`);
      this.lines = [];
      session.close();
      return true;
    }
    return false;
  }

  closed(session) {
    // Closed before the session was known (refused at once): connect() handles it.
    session?.onSnapshotClose?.();
    if (!session || session !== this.session) {
      return;
    }
    this.session = undefined;
    this.stopKeepAlive();
    this.settleWaiters({ closed: true });
    if (this.stopped || this.connectedAt === undefined) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  /**
   * An `ok` line answers the oldest line still waited for of the same
   * subunit and function whose waiter accepts its value (a write waits for
   * the value it set: a line pushed meanwhile with another value is not its
   * answer); the lines written before it and no longer waited for are
   * dropped (answered, or never to be: the receiver answers in order).
   * Without such a waiter, it is the late answer of the oldest line no longer
   * waited for of that function, if any. An `ok` line only carries a state,
   * the same for everyone: what must never go to the wrong line is a refusal.
   */
  answer({ subunit, fn, value }) {
    const same = (e) => e.subunit === subunit && e.fn === fn;
    let index = this.sent.findIndex((e) => same(e) && this.isLive(e) && e.waiter.accept(value));
    if (index === -1) {
      index = this.sent.findIndex((e) => same(e) && !this.isLive(e));
    }
    if (index === -1) {
      for (const entry of this.sent) {
        if (this.isLive(entry) && entry.subunit === subunit && entry.fn === fn) {
          entry.waiter.lastValue = value;
        }
      }
      return;
    }
    const matched = this.sent[index];
    this.sent = this.sent.filter((e, i) => i > index || (i < index && this.isLive(e)));
    this.settle(matched.waiter, { value });
  }

  settleWaiters(result) {
    for (const entry of this.sent.splice(0)) {
      this.settle(entry.waiter, result);
    }
  }

  startKeepAlive(session) {
    this.stopKeepAlive();
    this.lastLineAt = this.now();
    this.keepAliveTimer = this.timers.setInterval(() => {
      if (session !== this.session) {
        return;
      }
      if (this.now() - this.lastLineAt > this.timings.silenceTimeout) {
        this.logger?.info?.(`${this.key}: no answer to the keep-alive, connection closed`);
        session.close();
        return;
      }
      this.track(session, getLine('SYS', 'MODELNAME')).catch(() => {});
    }, this.timings.keepAlive);
  }

  stopKeepAlive() {
    this.timers.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  /**
   * Sends one line and waits for its answer: a line of the same subunit and
   * function whose value `accept` takes (`{ value }`), a refusal (`{
   * refused }`), the end of `timeoutMs` counted from the write (`{ timeout:
   * true, lastValue }`, `lastValue` being a value seen and not accepted) or
   * the end of the connection (`{ closed: true }`). Throws a DeviceError
   * UNREACHABLE when the line could not be written (nothing sent).
   */
  async exchange(subunit, fn, value, timeoutMs, accept = () => true) {
    if (!this.connected) {
      throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent');
    }
    const line = formatLine(subunit, fn, value);
    const session = this.session;
    let waiter;
    const answer = new Promise((resolve) => {
      waiter = { resolve, accept, done: false, lastValue: undefined };
    });
    // The waiter is tracked once the line is written: its answer can only come after.
    await this.track(session, line, waiter);
    if (session !== this.session) {
      this.settle(waiter, { closed: true });
      return answer;
    }
    if (!waiter.done) {
      waiter.timer = setTimeout(
        () => this.settle(waiter, { timeout: true, lastValue: waiter.lastValue }),
        Math.max(0, timeoutMs),
      );
    }
    return answer;
  }

  /** Reads one function (`?`): any value answers. */
  read(subunit, fn, timeoutMs) {
    return this.exchange(subunit, fn, '?', timeoutMs);
  }

  /** Writes one function: only a value `accept` takes confirms it. */
  write(subunit, fn, value, timeoutMs, accept = (v) => v === value) {
    return this.exchange(subunit, fn, value, timeoutMs, accept);
  }
}
