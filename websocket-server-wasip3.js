//! componentize-qjs WebSocket server state machine (WASI P3, async)
//! bun x componentize-qjs -n websocket-server-wasi-p3 -w ./p3/websocket \
//!  -m --opt-size --js ./p3/websocket-server-wasip3.js -o ./p3/websocket-server-wasip3.wasm
//! guest271314 11-1-2026 

import stdin from "wasi:cli/stdin@0.3.0";
import stdout from "wasi:cli/stdout@0.3.0";
import stderr from "wasi:cli/stderr@0.3.0";

import { TcpSocket } from "wasi:sockets/types@0.3.0";

const KEY_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BUFFER = 1024 * 1024;
const OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

let wsClosed = false;

function encode(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    u8[i] = str.charCodeAt(i);
  }
  return u8;
}
function decode(u8, n) {
  let str = "";
  for (let i = 0; i < n; i++) {
    str += String.fromCharCode(u8[i]);
  }
  return str;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  let i = 0;
  while (i + 2 < bytes.length) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += B64.charAt(n >> 18 & 63);
    out += B64.charAt(n >> 12 & 63);
    out += B64.charAt(n >> 6 & 63);
    out += B64.charAt(n & 63);
    i += 3;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64.charAt(n >> 18 & 63);
    out += B64.charAt(n >> 12 & 63);
    out += "==";
  } else if (rem === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += B64.charAt(n >> 18 & 63);
    out += B64.charAt(n >> 12 & 63);
    out += B64.charAt(n >> 6 & 63);
    out += "=";
  }
  return out;
}
function rotl(n, s) {
  return n << s | n >>> 32 - s;
}
function putWord(out, off, v) {
  out[off] = v >>> 24 & 255;
  out[off + 1] = v >>> 16 & 255;
  out[off + 2] = v >>> 8 & 255;
  out[off + 3] = v & 255;
}
function sha1(msg) {
  const len = msg.length;
  const padded = ((len + 9 + 63) / 64 | 0) * 64;
  const buf = new Uint8Array(padded);
  for (let i = 0; i < len; i++) {
    buf[i] = msg[i];
  }
  buf[len] = 128;
  const bits = len * 8;
  putWord(buf, padded - 8, bits / 4294967296 | 0);
  putWord(buf, padded - 4, bits | 0);
  let h0 = 1732584193 | 0;
  let h1 = 4023233417 | 0;
  let h2 = 2562383102 | 0;
  let h3 = 271733878 | 0;
  let h4 = 3285377520 | 0;
  const w = new Int32Array(80);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = buf[j] << 24 | buf[j + 1] << 16 | buf[j + 2] << 8 | buf[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (i < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708 | 0;
      } else {
        f = b ^ c ^ d;
        k = 3395469782 | 0;
      }
      const tmp = rotl(a, 5) + f + e + k + w[i] | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = h0 + a | 0;
    h1 = h1 + b | 0;
    h2 = h2 + c | 0;
    h3 = h3 + d | 0;
    h4 = h4 + e | 0;
  }
  const out = new Uint8Array(20);
  putWord(out, 0, h0);
  putWord(out, 4, h1);
  putWord(out, 8, h2);
  putWord(out, 12, h3);
  putWord(out, 16, h4);
  return out;
}

function encodeMessage(opcode, payload) {
  const length = payload.length;
  let header = 2;
  if (length >= 65536) {
    header = 10;
  } else if (length >= 126) {
    header = 4;
  }
  const buf = new Uint8Array(length + header);
  buf[0] = 128 | opcode;
  if (length < 126) {
    buf[1] = length;
  } else if (length < 65536) {
    buf[1] = 126;
    buf[2] = length >> 8 & 255;
    buf[3] = length & 255;
  } else {
    buf[1] = 127;
    buf[6] = length >>> 24 & 255;
    buf[7] = length >>> 16 & 255;
    buf[8] = length >>> 8 & 255;
    buf[9] = length & 255;
  }
  for (let i = 0; i < length; i++) {
    buf[header + i] = payload[i];
  }
  return buf;
}

let reader;
let out; // writable end of the stdout stream
let errOut; // writable end of the stderr stream

class Reader {
  constructor(input) {
    this.input = input;
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.eof = false;
  }
  async fill() {
    if (this.eof) return false;
    const chunk = await this.input.read(4096);
    if (!chunk || chunk.length === 0) {
      this.eof = true;
      return false;
    }
    this.buf = chunk;
    this.pos = 0;
    return true;
  }
  // Same contract as the sync readExact: fills buf[0..n), false on EOF.
  async readExact(buf, n) {
    let off = 0;
    while (off < n) {
      if (this.pos >= this.buf.length && !(await this.fill())) return false;
      const take = Math.min(n - off, this.buf.length - this.pos);
      buf.set(this.buf.subarray(this.pos, this.pos + take), off);
      this.pos += take;
      off += take;
    }
    return true;
  }
  // Same contract as nodeFsRead: read until \r\n\r\n or buf full.
  async readHeaders(buf) {
    let n = 0;
    while (n < buf.length) {
      if (this.pos >= this.buf.length && !(await this.fill())) break;
      buf[n++] = this.buf[this.pos++];
      if (
        n >= 4 && buf[n - 4] === 13 && buf[n - 3] === 10 &&
        buf[n - 2] === 13 && buf[n - 1] === 10
      ) break;
    }
    return n;
  }
}

async function nodeFsWrite(buf) {
  await out.writeAll(buf);
}

async function log(msg) {
  await errOut.writeAll(encode(msg + "\n"));
}

async function writeFrame(opcode, payload) {
  await nodeFsWrite(encodeMessage(opcode, payload));
}

async function closeConnection(code, reason) {
  if (wsClosed) return;
  let buffer = new Uint8Array(0);
  if (code !== 0) {
    buffer = new Uint8Array(reason.length + 2);
    buffer[0] = (code >> 8) & 255;
    buffer[1] = code & 255;
    buffer.set(reason, 2);
  }
  await writeFrame(OP_CLOSE, buffer);
  wsClosed = true;
}

async function handleFrame(opcode, payload) {
  if (opcode === OP_TEXT || opcode === OP_BINARY) {
    await writeFrame(opcode, payload);
  } else if (opcode === OP_PING) {
    await writeFrame(OP_PONG, payload);
  } else if (opcode === OP_PONG) {
    // ignore
  } else if (opcode === OP_CLOSE) {
    let code = 0;
    let reason = new Uint8Array(0);
    if (payload.length >= 2) {
      code = (payload[0] << 8) | payload[1];
      reason = payload.slice(2);
    }
    await closeConnection(code, reason);
  } else {
    await closeConnection(1002, encode("unknown opcode"));
  }
}

async function processWebSocketStream() {
  const head = new Uint8Array(2);
  const ext = new Uint8Array(8);
  const mask = new Uint8Array(4);
  const none = new Uint8Array(0);

  // State for reassembling fragmented data messages
  let msgOp = 0;
  let msgParts = [];
  let msgLen = 0;

  while (!wsClosed) {
    if (!(await reader.readExact(head, 2))) break;

    const fin = (head[0] & 128) !== 0;
    const rsv = head[0] & 0x70;
    const opcode = head[0] & 15;
    const masked = (head[1] & 128) !== 0;
    let length = head[1] & 127;

    // Client frames must be masked; RSV bits must be zero (no extensions negotiated)
    if (rsv !== 0 || !masked) {
      await closeConnection(1002, none);
      break;
    }

    if (length === 126) {
      if (!(await reader.readExact(ext, 2))) break;
      length = (ext[0] << 8) | ext[1];
    } else if (length === 127) {
      if (!(await reader.readExact(ext, 8))) break;
      if ((ext[0] | ext[1] | ext[2] | ext[3]) !== 0) {
        await closeConnection(1009, none);
        break;
      }
      length = ((ext[4] << 24) | (ext[5] << 16) | (ext[6] << 8) | ext[7]) >>> 0;
    }

    // Control frames: must not be fragmented, payload at most 125 bytes
    if (opcode >= 8 && (!fin || length > 125)) {
      await closeConnection(1002, none);
      break;
    }

    // Single frame too large
    if (length > MAX_BUFFER) {
      await closeConnection(1009, none);
      break;
    }

    if (!(await reader.readExact(mask, 4))) break;
    const payload = new Uint8Array(length);
    if (!(await reader.readExact(payload, length))) break;
    for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];

    if (opcode >= 8) {
      // Control frame (close, ping, pong): handle immediately, may interleave
      // with a fragmented data message
      await handleFrame(opcode, payload);
      continue;
    }

    // Data frame handling, including fragmentation
    if (opcode !== 0) {
      // Start of a new message; error if one is already in progress
      if (msgOp !== 0) {
        await closeConnection(1002, none);
        break;
      }
      msgOp = opcode;
    } else if (msgOp === 0) {
      // Continuation frame with nothing to continue
      await closeConnection(1002, none);
      break;
    }

    msgParts.push(payload);
    msgLen += payload.length;
    if (msgLen > MAX_BUFFER) {
      await closeConnection(1009, none);
      break;
    }

    if (fin) {
      const whole = new Uint8Array(msgLen);
      let o = 0;
      for (const p of msgParts) {
        whole.set(p, o);
        o += p.length;
      }
      const op = msgOp;
      msgOp = 0;
      msgParts = [];
      msgLen = 0;
      await handleFrame(op, whole);
    }
  }
}

async function hashWebSocketKey(secKeyWebSocket) {
  const key = base64(sha1(encode(secKeyWebSocket + KEY_SUFFIX)));
  const header =
    "HTTP/1.1 101 Web Socket Protocol Handshake\r\n" +
    "Upgrade: WebSocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-Websocket-Accept: " + key + "\r\n\r\n";
  await nodeFsWrite(encode(header));
}

export const run = {
  async run() {
    const [input, status] = stdin.readViaStream();

    const o = wit.Stream(wit.Stream.U8);
    out = o.writable;
    const writeDone = stdout.writeViaStream(o.readable);

    const e = wit.Stream(wit.Stream.U8);
    errOut = e.writable;
    const errDone = stderr.writeViaStream(e.readable);
    await log("componentize-qjs WebSocket state machine");
    reader = new Reader(input);
    try {
      const header = new Uint8Array(1024);
      const bytesRead = await reader.readHeaders(header);
      const headers = decode(header, bytesRead);
      const at = headers.toLowerCase().indexOf("sec-websocket-key:") + 18;
      const secWebSocketKey = headers
        .slice(at, headers.indexOf("\r\n", at))
        .trim();
      await hashWebSocketKey(secWebSocketKey);
      await processWebSocketStream();
    } finally {
      out.drop();
      errOut.drop();
      input.drop();
    }

    const written = await writeDone;
    if (written.tag === "err") throw written.val;
    const errWritten = await errDone;
    if (errWritten.tag === "err") throw errWritten.val;
    const statusResult = await status.read();
    if (statusResult.tag === "err") throw statusResult.val;
  },
};
