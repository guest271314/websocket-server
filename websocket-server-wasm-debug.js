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
const stdin = 0;
const stdout = 1;
const stderr = 2;
const KEY_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BUFFER = 1024 * 1024;
const OP_TEXT = 1;
const OP_BINARY = 2;
const OP_CLOSE = 8;
const OP_PING = 9;
const OP_PONG = 10;
function log(msg) {
  const b = encode(msg + `
`);
  writeSync(stderr, b, 0, b.length);
  return;
}
function nodeFsWrite(buf) {
  let n = 0;
  while (n < buf.length) {
    const w = writeSync(stdout, buf, n, buf.length);
    if (w <= 0) {
      return;
    }
    n = n + w;
  }
  return;
}
const oneByte = new Uint8Array(1);
function readByte() {
  const n = readSync(stdin, oneByte, 0, 1);
  if (n <= 0) {
    return -1;
  }
  return oneByte[0];
}
function readExact(buf, n) {
  for (let i = 0;i < n; i++) {
    const b = readByte();
    if (b < 0) {
      return false;
    }
    buf[i] = b;
  }
  return true;
}
function nodeFsRead(buf) {
  let n = 0;
  while (n < buf.length) {
    const b = readByte();
    if (b < 0)
      break;
    buf[n] = b;
    n++;
    if (n >= 4 && buf[n - 4] === 13 && buf[n - 3] === 10 && buf[n - 2] === 13 && buf[n - 1] === 10) {
      break;
    }
  }
  return n;
}
function encode(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0;i < str.length; i++) {
    u8[i] = str.charCodeAt(i);
  }
  return u8;
}
function decode(u8, n) {
  let str = "";
  for (let i = 0;i < n; i++) {
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
  for (let i = 0;i < len; i++) {
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
  for (let off = 0;off < padded; off += 64) {
    for (let i = 0;i < 16; i++) {
      const j = off + i * 4;
      w[i] = buf[j] << 24 | buf[j + 1] << 16 | buf[j + 2] << 8 | buf[j + 3];
    }
    for (let i = 16;i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0;i < 80; i++) {
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
let closed = false;
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
  for (let i = 0;i < length; i++) {
    buf[header + i] = payload[i];
  }
  return buf;
}
function writeFrame(opcode, payload) {
  nodeFsWrite(encodeMessage(opcode, payload));
  return;
}
function closeConnection(code, reason) {
  if (closed) {
    return;
  }
  let buffer = new Uint8Array(0);
  if (code !== 0) {
    buffer = new Uint8Array(reason.length + 2);
    buffer[0] = code >> 8 & 255;
    buffer[1] = code & 255;
    for (let i = 0;i < reason.length; i++) {
      buffer[2 + i] = reason[i];
    }
  }
  writeFrame(OP_CLOSE, buffer);
  closed = true;
  return;
}
function handleFrame(opcode, payload) {
  if (opcode === OP_TEXT || opcode === OP_BINARY) {
    writeFrame(opcode, payload);
  } else if (opcode === OP_PING) {
    writeFrame(OP_PONG, payload);
  } else if (opcode === OP_PONG) {} else if (opcode === OP_CLOSE) {
    let code = 0;
    let reason = new Uint8Array(0);
    if (payload.length >= 2) {
      code = payload[0] << 8 | payload[1];
      reason = new Uint8Array(payload.length - 2);
      for (let i = 0;i < reason.length; i++) {
        reason[i] = payload[2 + i];
      }
    }
    closeConnection(code, reason);
  } else {
    closeConnection(1002, encode("unknown opcode"));
  }
  return;
}
function processWebSocketStream() {
  const head = new Uint8Array(2);
  const ext = new Uint8Array(8);
  const mask = new Uint8Array(4);
  while (!closed) {
    if (!readExact(head, 2))
      break;
    const opcode = head[0] & 15;
    let length = head[1] & 127;
    if (length === 126) {
      if (!readExact(ext, 2))
        break;
      length = ext[0] << 8 | ext[1];
    } else if (length === 127) {
      if (!readExact(ext, 8))
        break;
      if ((ext[0] | ext[1] | ext[2] | ext[3]) !== 0) {
        closeConnection(1009, new Uint8Array(0));
        break;
      }
      length = (ext[4] << 24 | ext[5] << 16 | ext[6] << 8 | ext[7]) >>> 0;
    }
    if (length > MAX_BUFFER)
      break;
    if (!readExact(mask, 4))
      break;
    const payload = new Uint8Array(length);
    if (!readExact(payload, length))
      break;
    for (let i = 0;i < length; i++) {
      payload[i] = payload[i] ^ mask[i % 4];
    }
    handleFrame(opcode, payload);
  }
  return;
}
function hashWebSocketKey(secKeyWebSocket) {
  const hash = sha1(encode(secKeyWebSocket + KEY_SUFFIX));
  const key = base64(hash);
  const header = `HTTP/1.1 101 Web Socket Protocol Handshake\r
` + `Upgrade: WebSocket\r
` + `Connection: Upgrade\r
` + "Sec-Websocket-Accept: " + key + `\r
\r
`;
  nodeFsWrite(encode(header));
  return;
}
function main() {
  const header = new Uint8Array(1024);
  const bytesRead = nodeFsRead(header);
  const headers = decode(header, bytesRead);
  const at = headers.toLowerCase().indexOf("sec-websocket-key:") + 18;
  const secWebSocketKey = headers.slice(at, headers.indexOf(`\r
`, at)).trim();
  hashWebSocketKey(secWebSocketKey);
  processWebSocketStream();
  return;
}
main();
