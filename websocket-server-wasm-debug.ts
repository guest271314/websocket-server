//! JavaScript/TypeScript/WebAssembly runtime agnostic WebSocket server
//!
//! Fork of https://gist.github.com/d0ruk/3921918937e234988dfaccfdee781bd3
//!
//! The Definitive Guide to HTML5 WebSocket by Vanessa Wang, Frank Salim, and Peter Moskovits
//! p. 51, Building a Simple WebSocket Server
//!
//! Based on https://github.com/guest271314/websocket-server/blob/main/websocket-server.js
//!
//! https://github.com/dy/jz/issues/111
//!
//! guest271314, dy (https://github.com/dy) 10-31-2026
//!
//! Do What the Fuck You Want to Public License WTFPLv2 http://www.wtfpl.net/about/

import { readSync, writeSync } from "fs";

const stdin: number = 0;
const stdout: number = 1;
const stderr: number = 2;

const KEY_SUFFIX: string = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BUFFER: number = 1024 * 1024;

const OP_TEXT: number = 1;
const OP_BINARY: number = 2;
const OP_CLOSE: number = 8;
const OP_PING: number = 9;
const OP_PONG: number = 10;

// ---------------------------------------------------------------- I/O

function log(msg: string): void {
  const b: Uint8Array<ArrayBuffer> = encode(msg + "\n");
  writeSync(stderr, b, 0, b.length);
  return void(0);
}

function nodeFsWrite(buf: Uint8Array<ArrayBuffer>): void {
  let n: number = 0;
  while (n < buf.length) {
    const w: number = writeSync(stdout, buf, n, buf.length);
    if (w <= 0) {
      return void(0);
    }
    n = n + w;
  }
  return void(0);
}

const oneByte: Uint8Array<ArrayBuffer> = new Uint8Array(1);

// Reads exactly one byte so that no read ever waits for more input than needed.
// Returns -1 at end of input.
function readByte(): number {
  const n: number = readSync(stdin, oneByte, 0, 1);
  if (n <= 0) {
    // log("DEBUG readSync returned " + n);
    return -1;
  }
  return oneByte[0];
}

function readExact(buf: Uint8Array<ArrayBuffer>, n: number): boolean {
  for (let i: number = 0; i < n; i++) {
    const b: number = readByte();
    if (b < 0) {
      return false;
    }
    buf[i] = b;
  }
  return true;
}

// Reads the WebSocket request head: stops after CRLF CRLF or when buf is full.
function nodeFsRead(buf: Uint8Array<ArrayBuffer>): number {
  let n: number = 0;
  while (n < buf.length) {
    const b: number = readByte();
    if (b < 0) break;
    buf[n] = b;
    n++;
    if (
      n >= 4 &&
      buf[n - 4] === 13 &&
      buf[n - 3] === 10 &&
      buf[n - 2] === 13 &&
      buf[n - 1] === 10
    ) {
      break;
    }
  }
  return n;
}

function encode(str: string): Uint8Array<ArrayBuffer> {
  const u8: Uint8Array<ArrayBuffer> = new Uint8Array(str.length);
  for (let i: number = 0; i < str.length; i++) {
    u8[i] = str.charCodeAt(i);
  }
  return u8;
}

function decode(u8: Uint8Array<ArrayBuffer>, n: number): string {
  let str: string = "";
  for (let i: number = 0; i < n; i++) {
    str += String.fromCharCode(u8[i]);
  }
  return str;
}

// ---------------------------------------------------------------- base64

const B64: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array<ArrayBuffer>): string {
  let out: string = "";
  let i: number = 0;
  while (i + 2 < bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64.charAt((n >> 18) & 63);
    out += B64.charAt((n >> 12) & 63);
    out += B64.charAt((n >> 6) & 63);
    out += B64.charAt(n & 63);
    i += 3;
  }
  const rem: number = bytes.length - i;
  if (rem === 1) {
    const n: number = bytes[i] << 16;
    out += B64.charAt((n >> 18) & 63);
    out += B64.charAt((n >> 12) & 63);
    out += "==";
  } else if (rem === 2) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64.charAt((n >> 18) & 63);
    out += B64.charAt((n >> 12) & 63);
    out += B64.charAt((n >> 6) & 63);
    out += "=";
  }
  return out;
}

// ---------------------------------------------------------------- SHA-1

function rotl(n: number, s: number): number {
  return (n << s) | (n >>> (32 - s));
}

function putWord(out: Uint8Array<ArrayBuffer>, off: number, v: number): void {
  out[off] = (v >>> 24) & 255;
  out[off + 1] = (v >>> 16) & 255;
  out[off + 2] = (v >>> 8) & 255;
  out[off + 3] = v & 255;
}

function sha1(msg: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const len: number = msg.length;
  const padded: number = (((len + 9 + 63) / 64) | 0) * 64;
  const buf: Uint8Array<ArrayBuffer> = new Uint8Array(padded);
  for (let i: number = 0; i < len; i++) {
    buf[i] = msg[i];
  }
  buf[len] = 128;
  const bits: number = len * 8;
  putWord(buf, padded - 8, (bits / 4294967296) | 0);
  putWord(buf, padded - 4, bits | 0);

  let h0: number = 1732584193 | 0;
  let h1: number = 4023233417 | 0;
  let h2: number = 2562383102 | 0;
  let h3: number = 271733878 | 0;
  let h4: number = 3285377520 | 0;
  const w: Int32Array<ArrayBuffer> = new Int32Array(80);

  for (let off: number = 0; off < padded; off += 64) {
    for (let i: number = 0; i < 16; i++) {
      const j: number = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) |
        buf[j + 3];
    }
    for (let i: number = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a: number = h0;
    let b: number = h1;
    let c: number = h2;
    let d: number = h3;
    let e: number = h4;
    for (let i: number = 0; i < 80; i++) {
      let f: number = 0;
      let k: number = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 1518500249;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 2400959708 | 0;
      } else {
        f = b ^ c ^ d;
        k = 3395469782 | 0;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out: Uint8Array<ArrayBuffer> = new Uint8Array(20);
  putWord(out, 0, h0);
  putWord(out, 4, h1);
  putWord(out, 8, h2);
  putWord(out, 12, h3);
  putWord(out, 16, h4);
  return out;
}

// ---------------------------------------------------------------- WebSocket state

let closed: boolean = false;

function encodeMessage(opcode: number, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const length: number = payload.length;
  let header: number = 2;
  if (length >= 65536) {
    header = 10;
  } else if (length >= 126) {
    header = 4;
  }
  const buf: Uint8Array<ArrayBuffer> = new Uint8Array(length + header);
  buf[0] = 128 | opcode;
  if (length < 126) {
    buf[1] = length;
  } else if (length < 65536) {
    buf[1] = 126;
    buf[2] = (length >> 8) & 255;
    buf[3] = length & 255;
  } else {
    buf[1] = 127;
    buf[6] = (length >>> 24) & 255;
    buf[7] = (length >>> 16) & 255;
    buf[8] = (length >>> 8) & 255;
    buf[9] = length & 255;
  }
  for (let i: number = 0; i < length; i++) {
    buf[header + i] = payload[i];
  }
  return buf;
}

function writeFrame(opcode: number, payload: Uint8Array<ArrayBuffer>): void {
  nodeFsWrite(encodeMessage(opcode, payload));
  return void(0);
}

// code === 0 means "no status code"
function closeConnection(code: number, reason: Uint8Array<ArrayBuffer>): void {
  if (closed) {
    return void(0);
  }
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  if (code !== 0) {
    buffer = new Uint8Array(reason.length + 2);
    buffer[0] = (code >> 8) & 255;
    buffer[1] = code & 255;
    for (let i: number = 0; i < reason.length; i++) {
      buffer[2 + i] = reason[i];
    }
  }
  writeFrame(OP_CLOSE, buffer);
  closed = true;
  return void(0);
}

function handleFrame(opcode: number, payload: Uint8Array<ArrayBuffer>): void {
  if (opcode === OP_TEXT || opcode === OP_BINARY) {
    writeFrame(opcode, payload);
  } else if (opcode === OP_PING) {
    writeFrame(OP_PONG, payload);
  } else if (opcode === OP_PONG) {
    // ignore
  } else if (opcode === OP_CLOSE) {
    let code: number = 0;
    let reason: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    if (payload.length >= 2) {
      code = (payload[0] << 8) | payload[1];
      reason = new Uint8Array(payload.length - 2);
      for (let i: number = 0; i < reason.length; i++) {
        reason[i] = payload[2 + i];
      }
    }
    closeConnection(code, reason);
  } else {
    closeConnection(1002, encode("unknown opcode"));
  }
  return void(0);
}

function processWebSocketStream(): void {
  const head: Uint8Array<ArrayBuffer> = new Uint8Array(2);
  const ext: Uint8Array<ArrayBuffer>  = new Uint8Array(8);
  const mask: Uint8Array<ArrayBuffer>  = new Uint8Array(4);
  // Avoid wasmtime legacy-exceptions error/deprecation
  // try {
  while (!closed) {
    // log("DEBUG loop top");
    if (!readExact(head, 2)) break;
    const opcode: number = head[0] & 15;
    let length: number = head[1] & 127;
    if (length === 126) {
      if (!readExact(ext, 2)) break;
      length = (ext[0] << 8) | ext[1];
    } else if (length === 127) {
      if (!readExact(ext, 8)) break;
      if ((ext[0] | ext[1] | ext[2] | ext[3]) !== 0) {
        closeConnection(1009, new Uint8Array(0));
        break;
      }
      length = ((ext[4] << 24) | (ext[5] << 16) | (ext[6] << 8) | ext[7]) >>> 0;
    }
    if (length > MAX_BUFFER) break;
    if (!readExact(mask, 4)) break;
    const payload: Uint8Array<ArrayBuffer>  = new Uint8Array(length);
    if (!readExact(payload, length)) break;
    for (let i: number = 0; i < length; i++) {
      payload[i] = payload[i] ^ mask[i % 4];
    }
    // log("DEBUG frame op=" + opcode + " len=" + length);
    handleFrame(opcode, payload);
  }
  // log("DEBUG left loop, closed=" + closed);
  // } catch {
  // log("DEBUG caught exception");
  // }
  return void(0);
}

function hashWebSocketKey(secKeyWebSocket: string): void {
  const hash: Uint8Array<ArrayBuffer> = sha1(encode(secKeyWebSocket + KEY_SUFFIX));
  const key: string = base64(hash);
  const header: string = "HTTP/1.1 101 Web Socket Protocol Handshake\r\n" +
    "Upgrade: WebSocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-Websocket-Accept: " +
    key +
    "\r\n\r\n";
  nodeFsWrite(encode(header));
  return void(0);
}

// ---------------------------------------------------------------- entry point

function main(): void {
  const header: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  const bytesRead: number = nodeFsRead(header);
  const headers: string = decode(header, bytesRead);
  const at: number = headers.toLowerCase().indexOf("sec-websocket-key:") + 18;
  const secWebSocketKey: string = headers.slice(at, headers.indexOf("\r\n", at)).trim();
  hashWebSocketKey(secWebSocketKey);
  processWebSocketStream();
  return void(0);
}

main();
