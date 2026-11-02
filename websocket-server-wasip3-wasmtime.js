//! componentize-qjs WebSocket wasi TcpSocket, wasmtime -S inherit-network
//! wkg fetch --cache ./.wit-cache .
//! bun x componentize-qjs -n websocket-server-wasi-p3 -w ./p3/websocket -m --opt-size \
//!  --js ./p3/websocket-server-wasip3-wasmtime.js -o ./p3/websocket-server-wasip3-wasmtime.wasm
//! guest271314, 11-1-2026
import { TcpSocket } from "wasi:sockets/types@0.3.0";
import stdout from "wasi:cli/stdout@0.3.0";

const DEBUG = false;

let dbg;
async function trace(s, force = false) {
  if (!DEBUG && !force) return;
  await dbg.writeAll(encode("[" + s + "]\n"));
}
const KEY_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BUFFER = 1024 * 1024;
const OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

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

// RFC 6455 section 7.4: codes a peer may legitimately send in a close frame
function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999);
}

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
  // readExact and readHeaders unchanged
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

class Conn {
  constructor(reader, out) {
    this.reader = reader;
    this.out = out;
    this.closed = false;
  }
}

async function writeFrame(c, opcode, payload) {
  await c.out.writeAll(encodeMessage(opcode, payload));
}

async function closeConnection(c, code, reason) {
  if (c.closed) return;
  let buffer = new Uint8Array(0);
  if (code !== 0) {
    buffer = new Uint8Array(reason.length + 2);
    buffer[0] = (code >> 8) & 255;
    buffer[1] = code & 255;
    buffer.set(reason, 2);
  }
  await writeFrame(c, OP_CLOSE, buffer);
  c.closed = true;
}

async function handleFrame(c, opcode, payload) {
  if (opcode === OP_TEXT || opcode === OP_BINARY) {
    await writeFrame(c, opcode, payload);
  } else if (opcode === OP_PING) {
    await writeFrame(c, OP_PONG, payload);
  } else if (opcode === OP_PONG) {
    // ignore
  } else if (opcode === OP_CLOSE) {
    // A close payload is either empty or 2+ bytes (status code + optional reason)
    if (payload.length === 1) {
      await closeConnection(c, 1002, new Uint8Array(0));
      return;
    }
    let code = 0;
    let reason = new Uint8Array(0);
    if (payload.length >= 2) {
      code = (payload[0] << 8) | payload[1];
      if (!validCloseCode(code)) {
        await closeConnection(c, 1002, new Uint8Array(0));
        return;
      }
      reason = payload.slice(2);
    }
    await closeConnection(c, code, reason);
  } else {
    await closeConnection(c, 1002, encode("unknown opcode"));
  }
}

async function processWebSocketStream(c) {
  const reader = c.reader;
  const head = new Uint8Array(2);
  const ext = new Uint8Array(8);
  const mask = new Uint8Array(4);
  const none = new Uint8Array(0);
  let msgOp = 0, msgParts = [], msgLen = 0;

  while (!c.closed) {
    if (!(await reader.readExact(head, 2))) break;
    const fin = (head[0] & 128) !== 0;
    const rsv = head[0] & 0x70;
    const opcode = head[0] & 15;
    const masked = (head[1] & 128) !== 0;
    let length = head[1] & 127;

    if (rsv !== 0 || !masked) {
      await closeConnection(c, 1002, none);
      break;
    }

    // NEW: reject reserved opcodes (3-7, 11-15) immediately
    const known = opcode === 0 || opcode === 1 || opcode === 2 ||
      opcode === 8 || opcode === 9 || opcode === 10;
    if (!known) {
      await closeConnection(c, 1002, none);
      break;
    }

    if (length === 126) {
      if (!(await reader.readExact(ext, 2))) break;
      length = (ext[0] << 8) | ext[1];
    } else if (length === 127) {
      if (!(await reader.readExact(ext, 8))) break;
      if ((ext[0] | ext[1] | ext[2] | ext[3]) !== 0) {
        await closeConnection(c, 1009, none);
        break;
      }
      length = ((ext[4] << 24) | (ext[5] << 16) | (ext[6] << 8) | ext[7]) >>> 0;
    }

    if (opcode >= 8 && (!fin || length > 125)) {
      await closeConnection(c, 1002, none);
      break;
    }
    if (length > MAX_BUFFER) {
      await closeConnection(c, 1009, none);
      break;
    }

    if (!(await reader.readExact(mask, 4))) break;
    const payload = new Uint8Array(length);
    if (!(await reader.readExact(payload, length))) break;
    for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];

    if (opcode >= 8) {
      await handleFrame(c, opcode, payload);
      continue;
    }

    if (opcode !== 0) {
      if (msgOp !== 0) {
        await closeConnection(c, 1002, none);
        break;
      }
      msgOp = opcode;
    } else if (msgOp === 0) {
      await closeConnection(c, 1002, none);
      break;
    }

    msgParts.push(payload);
    msgLen += payload.length;
    if (msgLen > MAX_BUFFER) {
      await closeConnection(c, 1009, none);
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
      await handleFrame(c, op, whole);
    }
  }
}

async function rejectHandshake(c, status, extra) {
  await c.out.writeAll(encode(
    "HTTP/1.1 " + status + "\r\n" + (extra || "") +
      "Connection: close\r\nContent-Length: 0\r\n\r\n",
  ));
}

// Returns { key } on success or { status, extra } describing the rejection.
function parseHandshake(text) {
  const lines = text.split("\r\n");
  if (!/^GET \S+ HTTP\/1\.1$/.test(lines[0])) {
    return { status: "400 Bad Request" };
  }
  const h = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") break;
    const c = line.indexOf(":");
    if (c < 1) return { status: "400 Bad Request" };
    h[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  if (!(h["upgrade"] || "").toLowerCase().includes("websocket")) {
    return { status: "400 Bad Request" };
  }
  if (!(h["connection"] || "").toLowerCase().includes("upgrade")) {
    return { status: "400 Bad Request" };
  }
  if (h["sec-websocket-version"] !== "13") {
    return {
      status: "426 Upgrade Required",
      extra: "Sec-WebSocket-Version: 13\r\n",
    };
  }
  const key = h["sec-websocket-key"];
  if (!key || key.length !== 24) {
    return { status: "400 Bad Request" };
  }
  return { key };
}

async function handshake(c) {
  const header = new Uint8Array(8192);
  const n = await c.reader.readHeaders(header);
  if (n === 0) return false;
  const terminated = n >= 4 && header[n - 4] === 13 && header[n - 3] === 10 &&
    header[n - 2] === 13 && header[n - 1] === 10;
  if (!terminated) {
    await rejectHandshake(c, "431 Request Header Fields Too Large");
    return false;
  }
  const result = parseHandshake(decode(header, n));
  if (result.key === undefined) {
    await rejectHandshake(c, result.status, result.extra);
    return false;
  }
  const accept = base64(sha1(encode(result.key + KEY_SUFFIX)));
  await c.out.writeAll(encode(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  ));
  return true;
}

const step = (name, fn) => {
  try {
    return fn();
  } catch (e) {
    let detail;
    try {
      detail = JSON.stringify(e && e.payload !== undefined ? e.payload : e);
    } catch (_) {
      detail = String(e);
    }
    throw new Error(name + ": " + (e && e.message) + " payload=" + detail);
  }
};

async function handleConnection(sock) {
  await trace("conn: receive");
  const [input] = step("receive", () => sock.receive());
  await trace("conn: send");
  const o = wit.Stream(wit.Stream.U8_2);
  const sendDone = step("send", () => sock.send(o.readable));
  const c = new Conn(new Reader(input), o.writable);
  try {
    await trace("conn: handshake");
    const ok = await handshake(c);
    await trace("conn: handshake " + ok);
    if (ok) await processWebSocketStream(c);
  } catch (e) {
    await trace(
      "conn error: " + (e && (e.message || JSON.stringify(e.payload ?? e))),
      true,
    );
  } finally {
    c.out.drop();
    input.drop();
    await trace("conn: done");
    sock.drop();
  }
}

export const run = {
  async run() {
    const d = wit.Stream(wit.Stream.U8);
    dbg = d.writable;
    const dbgDone = stdout.writeViaStream(d.readable);
    await trace("start");
    const names = (o) => {
      const r = [];
      for (
        let p = o;
        p && p !== Object.prototype;
        p = Object.getPrototypeOf(p)
      ) {
        r.push(...Object.getOwnPropertyNames(p));
      }
      return r.join(",");
    };
    await trace("wit: " + names(wit));
    await trace("wit.Stream: " + names(wit.Stream));
    await trace("send.length: " + TcpSocket.prototype.send.length);
    const server = step("create", () => TcpSocket.create("ipv4"));
    await trace("created");
    step(
      "bind",
      () =>
        server.bind({
          tag: "ipv4",
          val: { port: 8080, address: [127, 0, 0, 1] },
        }),
    );
    await trace("bound");
    const accepted = step("listen", () => server.listen());
    await trace("listening");

    for (;;) {
      await trace("waiting for accept");
      const batch = await accepted.read(1);
      await trace("accepted: " + (batch && batch.length));
      if (!batch || batch.length === 0) break;
      for (const sock of batch) {
        handleConnection(sock).catch((e) =>
          trace(
            "conn failed: " +
              (e && (e.message || JSON.stringify(e.payload ?? e))),
            true,
          )
        );
      }
    }
    await trace("loop ended");
    d.writable.drop();
    await dbgDone;
  },
};
