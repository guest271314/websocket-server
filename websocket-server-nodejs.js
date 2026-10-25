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
