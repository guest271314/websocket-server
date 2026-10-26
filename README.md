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

## txiki.js

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

# License
Do What the Fuck You Want to Public License [WTFPLv2](http://www.wtfpl.net/about/)

sha1-uint8array: https://github.com/kawanet/sha1-uint8array/?tab=readme-ov-file#mit-license
