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
