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
