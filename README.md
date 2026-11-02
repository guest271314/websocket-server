# websocket-server
JavaScript runtime agnostic WebSocket server.

Fork of https://gist.github.com/d0ruk/3921918937e234988dfaccfdee781bd3, which is based on _The Definitive Guide to HTML5 WebSocket_ by Vanessa Wang, Frank Salim, and Peter Moskovits at p. 51, _Building a Simple WebSocket Server_.


# Usage

## Node.js

```
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketConnection } from "./websocket-server.js";

function handleRequest(req, res) {
  console.log("HTTP server got request");
  res.setHeader("Access-Control-Allow-Headers", req.header.origin);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Request-Method", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
async function handleUpgrade(req, socket, upgradeHead) {
  console.log("HTTP server got UPGRADE");
  try {
    const { readable, writable } = Duplex.toWeb(socket);
    await WebSocketConnection.hashWebSocketKey(
      req.headers["sec-websocket-key"],
      writable,
    );
    new WebSocketConnection(readable, writable).processWebSocketStream().catch(
      (e) => {
        throw e;
      },
    );
  } catch (e) {
    console.log(e);
  }
}

const port = 8080;
const host = "0.0.0.0";
const server = createServer(handleRequest);
server.on("upgrade", handleUpgrade);
server.listen({ port, host });
server.on(
  "listening",
  () => console.log(`WebSocket server listening on ${host}:${port}`),
);
```

## Deno

```
import { WebSocketConnection } from "./websocket-server.js";

const decoder = new TextDecoder();
const listener = Deno.listen({
  port: 8080,
});
const { hostname, port, transport } = listener.addr;
console.log(
  `Listening on hostname: ${hostname}, port: ${port}, transport: ${transport}`,
);
const abortable = new AbortController();
const {
  signal,
} = abortable;
for await (const conn of listener) {
  try {
    const {
      readable,
      writable,
    } = conn;
    const writer = writable.getWriter();
    await readable.pipeTo(
      new WritableStream({
        start(controller) {
          this.ws = void 0;
          const { readable: wsReadable, writable: wsWritable } =
              new TransformStream(),
            wsWriter = wsWritable.getWriter();
          Object.assign(this, { wsReadable, wsWritable, wsWriter });
        },
        async write(value, controller) {
          const request = decoder.decode(value);
          if (request.includes("Upgrade: websocket")) {
            const [key] = request.match(/(?<=Sec-WebSocket-Key: ).+/i);
            const handshake = await WebSocketConnection.hashWebSocketKey(
              key,
              writer,
            );
            this.ws = new WebSocketConnection(this.wsReadable, writer)
              .processWebSocketStream().catch((e) => {
                throw e;
              });
          } else {
            await this.wsWriter.ready;
            await this.wsWriter.write(value);
          }
        },
        close() {
          console.log("Stream closed");
        },
        abort(reason) {
          console.log({
            reason,
          });
        },
      }),
    ).then(() => {
      throw new Error("Stream aborted");
    });
  } catch (e) {
    console.log({
      e,
    });
    break;
  }
}
```

## Bun

```
import { WebSocketConnection } from "./websocket-server.js";

const decoder = new TextDecoder();
const server = Bun.listen({
  hostname: "0.0.0.0",
  port: 8080,
  socket: {
    async data(socket, data) {
      const request = decoder.decode(data);
      if (request.includes("Upgrade: websocket")) {
        const [key] = request.match(/(?<=Sec-WebSocket-Key: ).+/i);
        const handshake = await WebSocketConnection.hashWebSocketKey(
          key,
          socket,
        );
        const writable = new WritableStream({
          start: () => {
            this.pending = null;
            this.resume = null;
            this.flush = () => {
              if (!this.pending) return;
              const n = socket.write(this.pending);
              this.pending = n < this.pending.byteLength
                ? this.pending.subarray(n)
                : null;
              if (!this.pending) this.resume?.(), (this.resume = null);
            };
          },
          write: async (chunk) => {
            this.pending = chunk;
            this.flush();
            if (this.pending) await new Promise((r) => (this.resume = r));
          },
          close() {
            socket.end();
          },
        });
        new WebSocketConnection(socket.data.readable, writable)
          .processWebSocketStream().catch((e) => {
            throw e;
          });
      } else {
        await socket.data.writer.write(data);
      }
    },
    open(socket) {
      console.log("open");
      const { readable, writable } = new TransformStream();
      socket.data = { readable, writer: writable.getWriter() };
    },
    close(socket) {
      console.log("Socket closed");
    },
    drain(socket) {
      console.log("drain");
    },
    error(socket, error) {
      console.log(error);
    },
  },
});

const { hostname, port } = server;

console.log(
  `Listening on hostname: ${hostname}, port: ${port}`,
);
```

## Direct Sockets/txiki.js

```
import { WebSocketConnection } from "./websocket-server.js";

const decoder = new TextDecoder();

async function handleConnection(connection) {
  const wsConnection = await connection.opened;
  console.log(`WebSocket connection from ${wsConnection.remoteAddress}:${wsConnection.remotePort}`);
  const writer = wsConnection.writable.getWriter();
  const { readable: wsReadable, writable: wsWritable } = new TransformStream(
      {},
      {},
      {
        highWaterMark: 1,
      },
    ),
    wsWriter = wsWritable.getWriter();
  let ws;
  for await (const value of wsConnection.readable) {
    const request = decoder.decode(value);
    if (/upgrade: websocket/i.test(request)) {
      const [key] = request.match(/(?<=Sec-WebSocket-Key: ).+/i);
      const handshake = await WebSocketConnection.hashWebSocketKey(
        key,
        writer,
      );
      ws = new WebSocketConnection(wsReadable, writer)
        .processWebSocketStream().catch((e) => {
          throw e;
        });
    } else {
      await wsWriter.ready;
      await wsWriter.write(new Uint8Array(value));
    }
  }

  console.log("WebSocket client connection closed");
  await wsWriter.close();
}

const socket = new TCPServerSocket("0.0.0.0", {
  localPort: 8080,
});

const { readable, localAddress, localPort } = await socket.opened;

console.log(
  `${navigator.userAgent} WebSocket server listening on ${localAddress}:${localPort}`,
);

for await (const conn of readable) {
  try {
    handleConnection(conn).catch((e) => {
      console.log({ e });
    });
  } catch (e) {
    listener.close();
    console.log(e);
  }
}

```

## TypeScript/JavaScript AOT compiled to wasm32-wasip1/native executable WebSocket state machine: Bring your own socket

### jz

```shell
bun build websocket-server-wasm-debug.ts --target node --outfile websocket-server-wasm-debug.js --no-bundle
```

```shell
jz websocket-server-wasm-debug.js --host wasi -o websocket-server-wasi-jz-debug.wasm
```

```shell
node node-jspi-host.mjs ./websocket-server-wasi-jz-debug.wasm 8080
```


```shell
socat TCP-LISTEN:8080,reuseaddr,fork EXEC:"node --no-warnings node-wasi.mjs websocket-server-wasi-jz-debug.wasm"
```

```shell
socat TCP-LISTEN:8080,reuseaddr,fork SYSTEM:'wasmtime -W exceptions=y websocket-server-wasi-jz-debug.wasm'

```
### scriptc

```shell
SCRIPTC_NO_CACHE=1 SCRIPTC_TARGET=wasm32-wasi bun x scriptc \
build ~/bin/websocket-server-wasm/websocket-server-wasm-debug.ts \
--optimization=release --strip \
-o ~/bin/websocket-server-wasm/websocket-server-wasi-scriptc-debug.wasm
/home/user/bin/websocket-server-wasm/websocket-server-wasi-scriptc-debug.wasm
```

```shell
node node-jspi-host.mjs ./websocket-server-wasi-scriptc-debug.wasm 8080
```

```shell
socat TCP-LISTEN:8080,reuseaddr,fork SYSTEM:'wasmtime -W exceptions=y websocket-server-wasi-scriptc-debug.wasm'
```

#### Compile to native executable

```shell
SCRIPTC_CC="zig cc" SCRIPTC_NO_CACHE=1 bun x scriptc build ~/bin/websocket-server-wasm/websocket-server-wasm-debug.ts --optimization=release -o ~/bin/websocket-server-wasm/websocket-server-wasi-scriptc-debug
```

```shell
socat TCP-LISTEN:8080,reuseaddr,fork SYSTEM:'/home/user/bin/websocket-server-wasm/websocket-server-wasi-scriptc-debug'
```

### js2wasm 

```shell
bun ./node_modules/@loopdive/js2/src/cli.ts ~/bin/websocket-server-wasm/websocket-server-wasm-debug.ts --wit --target wasi -O4 -o ~/bin/js2wasm-out
/home/user/bin/js2wasm-out/websocket-server-wasm-debug.wasm  (22909 bytes)
/home/user/bin/js2wasm-out/websocket-server-wasm-debug.wat  (606876 chars)
/home/user/bin/js2wasm-out/websocket-server-wasm-debug.d.ts  (24 chars)
/home/user/bin/js2wasm-out/websocket-server-wasm-debug.imports.js  (3658 chars)
/home/user/bin/js2wasm-out/websocket-server-wasm-debug.wit  (324 chars)

To run: wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y /home/user/bin/js2wasm-out/websocket-server-wasm-debug.wasm
```

```shell
mv /home/user/bin/js2wasm-out/websocket-server-wasm-debug.wasm ~/bin/websocket-server-wasm/websocket-server-wasi-js2wasm-debug.wasm
```

Make sure to double-quote the value passed to `wasmtime`'s `-W` option to avoid this error `socat[87199] E parseopts_table(): unknown option "function-references"`
```shell
socat TCP-LISTEN:8080,reuseaddr,fork SYSTEM:'wasmtime -W "gc=y,function-references=y,tail-call=y,exceptions=y,exceptions=y" websocket-server-wasi-js2wasm-debug.wasm'

```

### componentize-qjs

QuickJS NG interpreter, not strictly AOT.

```javascript
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
```

```shell
wkg fetch --cache ./.wit-cache .
mkdir p3
mkdir p3/websocket
cp -r deps p3/websocket
```

```shell
bun x componentize-qjs -n websocket-server-wasi-p3 -w ./p3/websocket -m \
-opt-size --js ./p3/websocket-server-wasip3.js -o ./p3/websocket-server-wasip3.wasm
```

```shell
socat TCP-LISTEN:8080,reuseaddr,fork SYSTEM:'wasmtime -W component-model-async=y -S p3=y websocket-server-wasip3.wasm'
componentize-qjs WebSocket state machine
```

`package.wit`
```wit
package websocket-server:websocket-server-wasi-p3;
 
world websocket-server-wasi-p3 {
  import wasi:cli/stdin@0.3.0;
  import wasi:cli/stdout@0.3.0;
  import wasi:cli/stderr@0.3.0;

  export wasi:cli/run@0.3.0;
}
```

### Testing

Roundtrip text.
```shell
node client.mjs 8080
```

Roundtrip 20 MiB of `Uint8Array` data.
```shell
node websocket-stream-client.js
```

# License
Do What the Fuck You Want to Public License [WTFPLv2](http://www.wtfpl.net/about/)

`sha1-uint8array`: https://github.com/kawanet/sha1-uint8array/?tab=readme-ov-file#mit-license

`jz`: https://github.com/dy/jz/blob/main/LICENSE
