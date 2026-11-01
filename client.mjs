//! https://github.com/dy/jz/issues/111#issuecomment-6544755304
const ws = new WebSocket(`ws://127.0.0.1:${process.argv[2]}`);
ws.binaryType = "arraybuffer";
const t = setTimeout(() => {
  console.log("timeout, state", ws.readyState);
  process.exit(1);
}, 4000);
ws.onopen = () => {
  console.log("open");
  ws.send("hello jz");
};
ws.onmessage = (e) => {
  console.log("message:", typeof e.data === "string" ? e.data : e.data);
  ws.close(1000, "Done");
};
ws.onclose = (e) => {
  console.log("close", e.code, e.reason);
  clearTimeout(t);
  process.exit(0);
};
ws.onerror = (e) => console.log("error", e.message);
