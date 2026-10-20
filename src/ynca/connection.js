// -----------------------------------------------------------------------------
// One TCP session with a receiver: lines in (bounded, CR LF or LF ended), lines
// out (one at a time, 100 ms apart as the YNCA specification asks, a bounded
// queue). It knows nothing of YNCA values: src/ynca/link.js does.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = Object.freeze({
  /** Not connected: nothing sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time. */
  TIMEOUT: 'timeout',
  /** No time left: nothing sent. */
  BUDGET: 'budget',
  /** The receiver answered `@RESTRICTED` or `@UNDEFINED`. */
  REFUSED: 'refused',
  /** It answered, but not as a YNCA receiver. */
  PROTOCOL: 'protocol',
  /** The connection closed while waiting. */
  CLOSED: 'closed',
});

export class DeviceError extends Error {
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
  }
}

const defaultCreateSocket = (options) => net.createConnection(options);

/**
 * Opens a session. Resolves once connected; rejects (UNREACHABLE) when the
 * connection is refused or not open within `timeoutMs`.
 */
export function openSession({
  host,
  port,
  timeoutMs = TIMINGS.connectTimeout,
  spacing = TIMINGS.commandSpacing,
  createSocket = defaultCreateSocket,
  onLine = () => {},
  onClose = () => {},
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = createSocket({ host, port });
    const session = new Session(socket, { spacing, onLine, onClose });
    const timer = setTimeout(() => {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `No connection within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session.onClose = () => {};
      session.close();
      reject(err);
    };
    socket.once('connect', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session.open = true;
      resolve(session);
    });
    socket.once('error', (err) => {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `Connection failed (${err.code ?? 'error'})`));
    });
  });
}

export class Session {
  constructor(socket, { spacing, onLine, onClose }) {
    this.socket = socket;
    this.spacing = spacing;
    this.onLine = onLine;
    this.onClose = onClose;
    this.open = false;
    this.closed = false;
    this.buffer = '';
    /** Lines waiting to be written: { line, resolve, reject }. */
    this.queue = [];
    this.writing = false;
    socket.setEncoding('utf8');
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    this.buffer += chunk;
    let start = 0;
    let end = this.buffer.indexOf('\n', start);
    while (end !== -1) {
      let line = this.buffer.slice(start, end);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      start = end + 1;
      if (line.length > 0 && Buffer.byteLength(line) <= LIMITS.lineBytes) {
        this.onLine(line);
        if (this.closed) {
          return;
        }
      }
      end = this.buffer.indexOf('\n', start);
    }
    this.buffer = this.buffer.slice(start);
    if (Buffer.byteLength(this.buffer) > LIMITS.bufferBytes) {
      // No end of line in 4 KB: not a YNCA receiver, or a hostile one.
      this.close();
    }
  }

  /**
   * Queues one line. Resolves when it is written to the socket (it may then
   * have reached the receiver); rejects, nothing sent, when the session is
   * closed or the queue is full.
   */
  send(line) {
    if (this.closed || !this.open) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    if (this.queue.length >= LIMITS.sendQueue) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many lines waiting: nothing sent'),
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.writing || this.closed || this.queue.length === 0) {
      return;
    }
    this.writing = true;
    const item = this.queue.shift();
    this.socket.write(`${item.line}\r\n`);
    item.resolve();
    // The spacing of the YNCA specification, before the next line.
    setTimeout(() => {
      this.writing = false;
      this.pump();
    }, this.spacing);
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.open = false;
    for (const item of this.queue.splice(0)) {
      item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed: nothing sent'));
    }
    this.socket.destroy();
    this.onClose();
  }
}
