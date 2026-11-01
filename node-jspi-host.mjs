//! https://github.com/dy/jz/issues/111#issuecomment-6544755304
//! scriptc import more than just fd_read and fd_write from wasi_snapshot_p1
//! https://github.com/guest271314/deno-wasi/blob/runtime-agnostic-nodejs-api/wasi.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const clock_res_realtime = function () {
  return BigInt(1e6);
};
const clock_res_monotonic = function () {
  return BigInt(1e3);
};
const clock_res_process = clock_res_monotonic;
const clock_res_thread = clock_res_monotonic;
const clock_time_realtime = function () {
  return BigInt(Date.now()) * BigInt(1e6);
};
const clock_time_monotonic = function () {
  const t = performance.now();
  const s = Math.trunc(t);
  const ms = Math.floor((t - s) * 1e3);
  return BigInt(s) * BigInt(1e9) + BigInt(ms) * BigInt(1e6);
};
const clock_time_process = clock_time_monotonic;
const clock_time_thread = clock_time_monotonic;

const CLOCKID_REALTIME = 0;
const CLOCKID_MONOTONIC = 1;
const CLOCKID_PROCESS_CPUTIME_ID = 2;
const CLOCKID_THREAD_CPUTIME_ID = 3;
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;
const RIGHTS_FD_DATASYNC = 0x0000000000000001n;
const RIGHTS_FD_READ = 0x0000000000000002n;
const RIGHTS_FD_WRITE = 0x0000000000000040n;
const RIGHTS_FD_ALLOCATE = 0x0000000000000100n;
const RIGHTS_FD_READDIR = 0x0000000000004000n;
const RIGHTS_FD_FILESTAT_SET_SIZE = 0x0000000000400000n;
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;
const FDFLAGS_APPEND = 0x0001;
const FDFLAGS_DSYNC = 0x0002;
const FDFLAGS_NONBLOCK = 0x0004;
const FDFLAGS_RSYNC = 0x0008;
const FDFLAGS_SYNC = 0x0010;
const FSTFLAGS_ATIM_NOW = 0x0002;
const FSTFLAGS_MTIM_NOW = 0x0008;
const OFLAGS_CREAT = 0x0001;
const OFLAGS_DIRECTORY = 0x0002;
const OFLAGS_EXCL = 0x0004;
const OFLAGS_TRUNC = 0x0008;
const PREOPENTYPE_DIR = 0;

const mod = new WebAssembly.Module(
  readFileSync(process.argv[2] ?? "./websocket-server-wasi.wasm"),
);
const enc = new TextEncoder();

const server = createServer((req, res) => res.writeHead(426).end());
server.on("upgrade", (req, socket, head) => {
  // node has read the request already: hand it to the module as the first bytes of fd 0
  const request = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
    req.rawHeaders.map((v, i) => i % 2 ? `${v}\r\n` : `${v}: `).join("") +
    "\r\n";
  const queue = [
    enc.encode(request),
    ...(head.length ? [new Uint8Array(head)] : []),
  ];
  let wake = null, ended = false;
  socket.on("data", (d) => {
    queue.push(new Uint8Array(d));
    wake?.();
  });
  socket.on("end", () => {
    ended = true;
    wake?.();
  });
  socket.on("error", () => {
    ended = true;
    wake?.();
  });
  const next = async () => {
    while (!queue.length && !ended) await new Promise((r) => wake = r);
    return queue.shift() ?? new Uint8Array(0); // empty = EOF
  };

  let mem, rest = new Uint8Array(0);
  const dv = () => new DataView(mem.buffer);
  const iov = (p, i) =>
    new Uint8Array(
      mem.buffer,
      dv().getUint32(p + i * 8, true),
      dv().getUint32(p + i * 8 + 4, true),
    );
  const wasi_snapshot_preview1 = {
    fd_read: new WebAssembly.Suspending(async (fd, p, n, nread) => {
      if (!rest.length) rest = await next();
      let t = 0;
      for (let i = 0; i < n && rest.length; i++) {
        const b = iov(p, i), k = Math.min(b.length, rest.length);
        b.set(rest.subarray(0, k));
        rest = rest.subarray(k);
        t += k;
      }
      dv().setUint32(nread, t, true);
      return 0;
    }),
    fd_write: new WebAssembly.Suspending(async (fd, p, n, nw) => {
      let t = 0;
      for (let i = 0; i < n; i++) {
        const b = iov(p, i);
        if (fd === 1) socket.write(b.slice());
        else process.stderr.write(b.slice());
        t += b.length;
      }
      dv().setUint32(nw, t, true);
      return 0;
    }),
    args_get: (...args) => {
      return ERRNO_SUCCESS;
    },
    args_sizes_get: (...args) => {
      return ERRNO_SUCCESS;
    },
    environ_get: (environ_ptr, environ_buf_ptr) => {
      const entries = Object.entries(this.env);
      const heap = new Uint8Array(this.memory.buffer);
      const view = new DataView(this.memory.buffer);
      for (let [key, value] of entries) {
        view.setUint32(environ_ptr, environ_buf_ptr, true);
        environ_ptr += 4;
        const data = enc.encode(`${key}=${value}\x00`);
        heap.set(data, environ_buf_ptr);
        environ_buf_ptr += data.length;
      }
      return ERRNO_SUCCESS;
    },
    environ_sizes_get: (environc_out, environ_buf_size_out) => {
      if (!this || !this.env) return ERRNO_SUCCESS;
      const entries = Object.entries(this.env);
      const view = new DataView(this.memory.buffer);
      view.setUint32(environc_out, entries.length, true);
      view.setUint32(
        environ_buf_size_out,
        entries.reduce(function (acc, [key, value]) {
          return acc + enc.encode(`${key}=${value}\x00`).length;
        }, 0),
        true,
      );
      return ERRNO_SUCCESS;
    },
    clock_time_get: (id, precision, time_out) => {
      const view = new DataView(mem.buffer);
      switch (id) {
        case CLOCKID_REALTIME:
          view.setBigUint64(time_out, clock_time_realtime(), true);
          break;
        case CLOCKID_MONOTONIC:
          view.setBigUint64(time_out, clock_time_monotonic(), true);
          break;
        case CLOCKID_PROCESS_CPUTIME_ID:
          view.setBigUint64(time_out, clock_time_process(), true);
          break;
        case CLOCKID_THREAD_CPUTIME_ID:
          view.setBigUint64(time_out, clock_time_thread(), true);
          break;
        default:
          return ERRNO_INVAL;
      }
      return ERRNO_SUCCESS;
    },
    fd_fdstat_get: (fd, stat_out) => {
      const entry = this.fds[fd];
      if (!entry) {
        return ERRNO_BADF;
      }
      const view = new DataView(this.memory.buffer);
      view.setUint8(stat_out, entry.type);
      view.setUint16(stat_out + 4, 0, true);
      view.setBigUint64(stat_out + 8, 0n, true);
      view.setBigUint64(stat_out + 16, 0n, true);
      return ERRNO_SUCCESS;
    },
    fd_pread: (fd, iovs_ptr, iovs_len, offset, nread_out) => {
      /*
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const seek = entry.handle.seekSync(0, 1);
        const view = new DataView(this.memory.buffer);
        let nread = 0;
        for (let i = 0; i < iovs_len; i++) {
          const data_ptr = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data_len = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data = new Uint8Array(this.memory.buffer, data_ptr, data_len);
          nread += entry.handle.readSync(data);
        }
        entry.handle.seekSync(seek, 0);
        view.setUint32(nread_out, nread, true);
      */
      return ERRNO_SUCCESS;
    },
    fd_pwrite: (fd, iovs_ptr, iovs_len, offset, nwritten_out) => {
      /*
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const seek = entry.handle.seekSync(0, 1);
        const view = new DataView(this.memory.buffer);
        let nwritten = 0;
        for (let i = 0; i < iovs_len; i++) {
          const data_ptr = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data_len = view.getUint32(iovs_ptr, true);
          iovs_ptr += 4;
          const data = new Uint8Array(this.memory.buffer, data_ptr, data_len);
          nwritten += entry.handle.writeSync(data);
        }
        entry.handle.seekSync(seek, 0);
        view.setUint32(nwritten_out, nwritten, true);
      */
      return ERRNO_SUCCESS;
    },
    fd_seek: (fd, offset, whence, newoffset_out) => {
      /*
        const entry = this.fds[fd];
        if (!entry) {
          return ERRNO_BADF;
        }
        const view = new DataView(this.memory.buffer);
        try {
          const newoffset = entry.handle.seekSync(Number(offset), whence);
          view.setBigUint64(newoffset_out, BigInt(newoffset), true);
        } catch (err) {
          return ERRNO_INVAL;
        }
      */
      return ERRNO_SUCCESS;
    },
    proc_exit: (rval) => {
      process.exit(rval);
    },
    fd_close: (fd) => {
      const entry = this.fds[fd];
      if (!entry) {
        return ERRNO_BADF;
      }
      entry.handle.close();
      delete this.fds[fd];
      return ERRNO_SUCCESS;
    },
  };
  const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1 });
  mem = inst.exports.memory;
  (async () => {
    if (inst.exports._initialize) {
      await WebAssembly.promising(inst.exports._initialize)(); // top-level code
    }
    if (inst.exports._start) await WebAssembly.promising(inst.exports._start)(); // the server
  })().catch((e) => console.error(e)).finally(() => socket.end());
});
server.listen(
  +(process.argv[3] ?? 8080),
  "127.0.0.1",
  () => console.log("listening", server.address().port),
);
