import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] ?? 8080);
const MAX = 1024 * 1024; // must match MAX_BUFFER in the server

// ---- frame builder ----
function frame({ fin = true, rsv = 0, opcode, payload = Buffer.alloc(0), mask = true, lenOverride }) {
  const len = lenOverride ?? payload.length;
  let hdr;
  if (len < 126) hdr = Buffer.from([0, len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  hdr[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  if (!mask) return Buffer.concat([hdr, payload]);
  hdr[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([hdr, key, body]);
}

// ---- client ----
async function connect() {
  const sock = net.connect(PORT, "127.0.0.1");
  let buf = Buffer.alloc(0);
  let ended = false, err = null;
  const waiters = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); wake(); });
  sock.on("end", () => { ended = true; wake(); });
  sock.on("close", () => { ended = true; wake(); });
  sock.on("error", (e) => { err = e; ended = true; wake(); });
  const need = (pred) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), 10000);
    const check = () => {
      if (pred()) { clearTimeout(t); res(true); }
      else if (ended) { clearTimeout(t); res(false); }
      else waiters.push(check);
    };
    check();
  });

  const key = crypto.randomBytes(16).toString("base64");
  sock.write(
    `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  if (!(await need(() => buf.includes("\r\n\r\n")))) throw new Error("no handshake response");
  const end = buf.indexOf("\r\n\r\n") + 4;
  const head = buf.subarray(0, end).toString("latin1");
  buf = buf.subarray(end);
  const expect = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  if (!head.startsWith("HTTP/1.1 101") || !head.includes(expect)) {
    throw new Error("bad handshake: " + head.split("\r\n")[0]);
  }

  // Read one server frame. Returns null on EOF/reset before a full frame.
  async function read() {
    for (;;) {
      if (buf.length >= 2) {
        let l = buf[1] & 127, off = 2;
        if (l === 126) { if (buf.length < 4) { if (!(await need(() => buf.length >= 4))) return null; continue; } l = buf.readUInt16BE(2); off = 4; }
        else if (l === 127) { if (buf.length < 10) { if (!(await need(() => buf.length >= 10))) return null; continue; } l = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length >= off + l) {
          const f = { fin: !!(buf[0] & 0x80), opcode: buf[0] & 15, payload: Buffer.from(buf.subarray(off, off + l)) };
          buf = buf.subarray(off + l);
          return f;
        }
      }
      const before = buf.length;
      if (!(await need(() => buf.length > before))) return null;
    }
  }
  return { sock, read, send: (b) => sock.write(b), err: () => err, destroy: () => sock.destroy() };
}

// ---- harness ----
let pass = 0, fail = 0;
async function test(name, fn) {
  let c;
  try {
    c = await connect();
    const r = await fn(c);
    if (r === true) { pass++; console.log("PASS", name); }
    else { fail++; console.log("FAIL", name, r ?? ""); }
  } catch (e) {
    fail++; console.log("FAIL", name, "-", e.message);
  } finally { c?.destroy(); }
}
const eq = (a, b) => Buffer.compare(a, b) === 0;
const closeCode = (f) => (f && f.opcode === 8 && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null);

// 1. Boundary lengths: echo as text (ASCII) and binary
const sizes = [0, 1, 2, 124, 125, 126, 127, 128, 65534, 65535, 65536, 65537, MAX];
for (const n of sizes) {
  await test(`echo binary len=${n}`, async (c) => {
    const p = crypto.randomBytes(n);
    c.send(frame({ opcode: 2, payload: p }));
    const f = await c.read();
    if (!f) return "no reply";
    return f.opcode === 2 && f.fin && eq(f.payload, p) ? true : `opcode=${f.opcode} len=${f.payload.length}`;
  });
  await test(`echo text len=${n}`, async (c) => {
    const p = Buffer.alloc(n, 0x61);
    c.send(frame({ opcode: 1, payload: p }));
    const f = await c.read();
    if (!f) return "no reply";
    return f.opcode === 1 && eq(f.payload, p) ? true : `opcode=${f.opcode} len=${f.payload.length}`;
  });
}
await test(`len=MAX+1 -> close 1009`, async (c) => {
  c.send(frame({ opcode: 2, payload: Buffer.alloc(MAX + 1, 1) }));
  const f = await c.read();
  const code = closeCode(f);
  return code === 1009 ? true : f ? `got opcode=${f.opcode} code=${code}` : "reset before close frame (inconclusive)";
});
await test(`64-bit length with high bits set -> close 1009`, async (c) => {
  const hdr = Buffer.alloc(10 + 4);
  hdr[0] = 0x82; hdr[1] = 0x80 | 127;
  hdr.writeBigUInt64BE(1n << 40n, 2); // mask key left as zeros
  c.send(hdr);
  const f = await c.read();
  return closeCode(f) === 1009 ? true : `code=${closeCode(f)}`;
});

// 2. Fragmentation
await test("3-fragment text message reassembled", async (c) => {
  c.send(frame({ fin: false, opcode: 1, payload: Buffer.from("hel") }));
  c.send(frame({ fin: false, opcode: 0, payload: Buffer.from("lo ") }));
  c.send(frame({ fin: true, opcode: 0, payload: Buffer.from("world") }));
  const f = await c.read();
  return f && f.opcode === 1 && f.payload.toString() === "hello world" ? true : `${f && f.payload.toString()}`;
});
await test("fragmented binary spanning length classes", async (c) => {
  const a = crypto.randomBytes(100), b = crypto.randomBytes(70000), d = crypto.randomBytes(5);
  c.send(frame({ fin: false, opcode: 2, payload: a }));
  c.send(frame({ fin: false, opcode: 0, payload: b }));
  c.send(frame({ fin: true, opcode: 0, payload: d }));
  const f = await c.read();
  return f && f.opcode === 2 && eq(f.payload, Buffer.concat([a, b, d])) ? true : "mismatch";
});
await test("ping between fragments: pong first, message intact", async (c) => {
  c.send(frame({ fin: false, opcode: 1, payload: Buffer.from("ab") }));
  c.send(frame({ opcode: 9, payload: Buffer.from("pp") }));
  c.send(frame({ fin: true, opcode: 0, payload: Buffer.from("cd") }));
  const f1 = await c.read();
  if (!f1 || f1.opcode !== 10 || f1.payload.toString() !== "pp") return `first frame opcode=${f1 && f1.opcode}`;
  const f2 = await c.read();
  return f2 && f2.opcode === 1 && f2.payload.toString() === "abcd" ? true : "message not intact";
});
await test("two messages back to back", async (c) => {
  c.send(frame({ opcode: 1, payload: Buffer.from("one") }));
  c.send(frame({ opcode: 1, payload: Buffer.from("two") }));
  const a = await c.read(), b = await c.read();
  return a && b && a.payload.toString() === "one" && b.payload.toString() === "two" ? true : "bad";
});
await test("fragments exceeding MAX in total -> 1009", async (c) => {
  const half = Buffer.alloc(MAX / 2 + 1, 1);
  c.send(frame({ fin: false, opcode: 2, payload: half }));
  c.send(frame({ fin: false, opcode: 0, payload: half }));
  const f = await c.read();
  return closeCode(f) === 1009 ? true : `code=${closeCode(f)}`;
});

// 3. Fragmentation / frame violations -> 1002
const bad = [
  ["continuation with nothing in progress", () => frame({ opcode: 0, payload: Buffer.from("x") })],
  ["new data frame mid-message", null],
  ["fragmented control frame (ping, FIN=0)", () => frame({ fin: false, opcode: 9 })],
  ["control payload 126 bytes", () => frame({ opcode: 9, payload: Buffer.alloc(126) })],
  ["unmasked client frame", () => frame({ opcode: 1, payload: Buffer.from("x"), mask: false })],
  ["RSV1 set", () => frame({ opcode: 1, rsv: 4, payload: Buffer.from("x") })],
  ["unknown opcode 3", () => frame({ opcode: 3 })],
];
for (const [name, build] of bad) {
  await test(`violation: ${name} -> 1002`, async (c) => {
    if (build) c.send(build());
    else {
      c.send(frame({ fin: false, opcode: 1, payload: Buffer.from("a") }));
      c.send(frame({ opcode: 1, payload: Buffer.from("b") }));
    }
    const f = await c.read();
    return closeCode(f) === 1002 ? true : `code=${closeCode(f)} opcode=${f && f.opcode}`;
  });
}

// 4. Close handshake
await test("close echoes code, then connection ends", async (c) => {
  const p = Buffer.alloc(2 + 3); p.writeUInt16BE(1000, 0); p.write("bye", 2);
  c.send(frame({ opcode: 8, payload: p }));
  const f = await c.read();
  if (closeCode(f) !== 1000) return `code=${closeCode(f)}`;
  const after = await c.read();
  return after === null ? true : "connection stayed open";
});

await test("unknown opcode 3 with FIN=0 -> 1002 immediately", async (c) => {
  c.send(frame({ fin: false, opcode: 3, payload: Buffer.from("x") }));
  const f = await c.read();
  return closeCode(f) === 1002 ? true : `code=${closeCode(f)}`;
});

// ---- handshake / lifecycle tests ----
const GOOD_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const req = (o = {}) => {
  const lines = [o.line ?? "GET / HTTP/1.1", "Host: x"];
  if (o.upgrade !== false) lines.push("Upgrade: websocket");
  if (o.connection !== false) lines.push("Connection: Upgrade");
  if (o.key !== false) lines.push("Sec-WebSocket-Key: " + (o.key ?? GOOD_KEY));
  lines.push("Sec-WebSocket-Version: " + (o.version ?? "13"));
  return lines.join("\r\n") + "\r\n\r\n";
};

// Send bytes (optionally in small chunks), collect everything until the server closes or timeout.
function raw(data, { chunk = 0, delay = 0, wait = 1500 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    const parts = [];
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); s.destroy(); resolve(Buffer.concat(parts)); } };
    const t = setTimeout(finish, wait);
    s.on("data", (d) => parts.push(d));
    s.on("close", finish);
    s.on("error", finish);
    s.on("connect", async () => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
      if (!chunk) { s.write(b); return; }
      for (let i = 0; i < b.length; i += chunk) {
        s.write(b.subarray(i, i + chunk));
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
    });
  });
}
const status = (buf) => buf.toString("latin1").split("\r\n")[0];

const rejects = [
  ["missing key", req({ key: false }), "400"],
  ["23-char key", req({ key: GOOD_KEY.slice(0, 23) }), "400"],
  ["version 8", req({ version: "8" }), "426"],
  ["POST instead of GET", req({ line: "POST / HTTP/1.1" }), "400"],
  ["HTTP/1.0 request line", req({ line: "GET / HTTP/1.0" }), "400"],
  ["missing Upgrade header", req({ upgrade: false }), "400"],
  ["missing Connection header", req({ connection: false }), "400"],
  ["plain garbage", "hello world\r\n\r\n", "400"],
];
for (const [name, text, code] of rejects) {
  const r = await raw(text);
  const ok = status(r).startsWith("HTTP/1.1 " + code);
  console.log(ok ? "PASS" : "FAIL", `handshake: ${name} -> ${code}`, ok ? "" : `got "${status(r)}"`);
  ok ? pass++ : fail++;
}
{
  // >8 KiB of headers with no terminator: expect 431 (or a reset, which is also acceptable)
  const big = "GET / HTTP/1.1\r\nHost: x\r\nX-Pad: " + "a".repeat(9000);
  const r = await raw(big);
  const ok = status(r).startsWith("HTTP/1.1 431") || r.length === 0;
  console.log(ok ? "PASS" : "FAIL", "handshake: oversized headers -> 431/close", ok ? "" : `got "${status(r)}"`);
  ok ? pass++ : fail++;
}
{
  // handshake delivered one byte at a time
  const r = await raw(req(), { chunk: 1, delay: 1, wait: 3000 });
  const ok = status(r).startsWith("HTTP/1.1 101");
  console.log(ok ? "PASS" : "FAIL", "handshake: one byte at a time -> 101", ok ? "" : `got "${status(r)}"`);
  ok ? pass++ : fail++;
}
{
  // handshake + first frame in one write: bytes after \r\n\r\n must not be lost
  const msg = Buffer.concat([Buffer.from(req(), "latin1"), frame({ opcode: 1, payload: Buffer.from("early") })]);
  const r = await raw(msg);
  const end = r.indexOf("\r\n\r\n") + 4;
  const body = r.subarray(end);
  const ok = status(r).startsWith("HTTP/1.1 101") && body.length >= 7 && body[0] === 0x81 && body.subarray(2, 7).toString() === "early";
  console.log(ok ? "PASS" : "FAIL", "handshake + frame in one write -> echo", ok ? "" : `got ${body.length} body bytes`);
  ok ? pass++ : fail++;
}

// close edge cases
await test("close with empty payload -> empty close, then end", async (c) => {
  c.send(frame({ opcode: 8 }));
  const f = await c.read();
  if (!f || f.opcode !== 8) return "no close reply";
  return (await c.read()) === null ? true : "connection stayed open";
});
await test("close with 1-byte payload (malformed) -> 1002", async (c) => {
  c.send(frame({ opcode: 8, payload: Buffer.from([0x03]) }));
  const f = await c.read();
  return closeCode(f) === 1002 ? true : `code=${closeCode(f)} opcode=${f && f.opcode} (spec wants 1002)`;
});
await test("data after close frame is ignored", async (c) => {
  const p = Buffer.alloc(2); p.writeUInt16BE(1000, 0);
  c.send(Buffer.concat([frame({ opcode: 8, payload: p }), frame({ opcode: 1, payload: Buffer.from("late") })]));
  const f = await c.read();
  if (closeCode(f) !== 1000) return `code=${closeCode(f)}`;
  return (await c.read()) === null ? true : "server sent more after close";
});

// abrupt disconnects, then confirm the server still serves
for (const [name, bytes] of [
  ["mid-handshake", Buffer.from("GET / HTTP/1.1\r\nHost: x\r\nUpg")],
  ["mid-frame header", null],
  ["mid-payload", null],
]) {
  const c = name === "mid-handshake" ? null : await connect();
  if (c) {
    const f = frame({ opcode: 2, payload: Buffer.alloc(1000, 7) });
    c.send(name === "mid-frame header" ? f.subarray(0, 1) : f.subarray(0, 500));
    c.destroy();
  } else {
    await raw(bytes, { wait: 200 });
  }
  let ok = false;
  try {
    const c2 = await connect();
    c2.send(frame({ opcode: 1, payload: Buffer.from("alive") }));
    const f = await c2.read();
    ok = !!f && f.payload.toString() === "alive";
    c2.destroy();
  } catch {}
  console.log(ok ? "PASS" : "FAIL", `server survives disconnect ${name}`);
  ok ? pass++ : fail++;
}

// concurrency: 100 simultaneous clients, each echoing 3 messages
{
  const results = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
    try {
      const c = await connect();
      for (let m = 0; m < 3; m++) {
        const p = crypto.randomBytes(1000 + i);
        c.send(frame({ opcode: 2, payload: p }));
        const f = await c.read();
        if (!f || !eq(f.payload, p)) { c.destroy(); return false; }
      }
      c.destroy();
      return true;
    } catch { return false; }
  }));
  const good = results.filter(Boolean).length;
  console.log(good === 100 ? "PASS" : "FAIL", `100 concurrent clients (${good}/100 ok)`);
  good === 100 ? pass++ : fail++;
}

for (const code of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000]) {
  await test(`close with invalid code ${code} -> 1002`, async (c) => {
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    c.send(frame({ opcode: 8, payload: p }));
    const f = await c.read();
    return closeCode(f) === 1002 ? true : `code=${closeCode(f)}`;
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
