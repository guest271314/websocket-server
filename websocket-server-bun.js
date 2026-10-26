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
