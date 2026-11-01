console.log(`\u001b[1;32m${navigator.userAgent}\x1b[0m`);

class WebSocketStreamImpl {
  #ws;
  #readableController;
  #writableController;
  #readable;
  #writable;
  #handleCloseEvent;
  #closedPromise = Promise.withResolvers();
  #openedPromise = Promise.withResolvers();
  #readyState = {
    0: "CONNECTING",
    1: "OPEN",
    2: "CLOSING",
    3: "CLOSED"
  };
  opened;
  closed;
  url;
  signal;
  protocols = [];
  constructor(url, options = {}) {
    try {
      this.url = url;
      if (options?.protocols) {
        this.protocols = options.protocols;
      }
      if (options?.signal) {
        this.signal = options.signal;
        this.signal.addEventListener("abort", async (e) => {
          try {
            this.#closedPromise.reject(
              new DOMException("WebSocket handshake was aborted", "ABORT_ERR"),
            );
            this.#openedPromise.reject(
              new DOMException("WebSocket handshake was aborted", "ABORT_ERR"),
            );
          } catch (e) {
            console.log(e);
          }
        });
      }
      this.#openedPromise.promise.catch(() => {});
      this.#closedPromise.promise.catch(() => {});
      this.closed = this.#closedPromise.promise.catch((e) => {
        throw e;
      });
      this.opened = new Promise(async (resolve, reject) => {
        try {
          const aborted = this.signal?.aborted;
          if (aborted) {
            return reject(this.#openedPromise);
          }
        } catch {
          return;
        }
        const args = [url, {
          protocols: this.protocols
        }];
        if (this.protocols.length === 0) {
          args.pop();
        }
        this.#handleCloseEvent = function handleCloseEvent(e) {
          const {
            code,
            reason
          } = e;
          //console.log("close event", e);
          try {
            if (this.#readable.locked) {
              this.#readableController.close();
            }
            if (this.#writable.locked) {
              this.#writable.close().catch(() => {});
            }
            this.#closedPromise.resolve({
              closeCode: code,
              reason
            });
          } catch (e) {} finally {
            console.log(`\u001b[1;33mAsserting WebSocket.readyState is CLOSED\x1b[0m`);
            //console.log(`\u001b[1;31m`);
            console.assert(this.#ws.readyState === this.#ws.CLOSED, [
              `${navigator.userAgent}`,
              `Expected: ${this.#ws.CLOSED} (${this.#readyState[3]}), got ${this.#ws.readyState} (${
                this.#readyState[this.#ws.readyState]
              })`,
            ]);
            //console.log(`\x1b[0m`);
          }
        };
        this.#ws = new WebSocket(...args);
        this.#ws.binaryType = "arraybuffer";
        this.#ws.addEventListener("close", this.#handleCloseEvent.bind(this));
        this.#ws.addEventListener("error", (e) => {
          this.#closedPromise.reject(e);
        }, {
          once: true
        });
        this.#ws.addEventListener("message", (e) => {
          this.#readableController.enqueue(e.data);
        });
        this.#ws.addEventListener("open", (e) => {
          // console.log(e, this);
          this.#readable = new ReadableStream({
            start: (c) => {
              this.#readableController = c;
            },
            cancel: async (reason) => {
              console.log(reason);
              await this.#writable.close();
            },
          });
          this.#writable = new WritableStream({
            start: (c) => {
              this.#writableController = c;
            },
            write: (value) => {
              this.#ws.send(value);
            },
            close: () => {
              //console.log("close");
              this.#readableController.close();
              this.#ws.close();
            },
            abort: (reason) => {},
          });
          resolve({
            readable: this.#readable,
            writable: this.#writable,
          });
        });
      }).catch((e) => {
        throw e;
      });
    } catch (e) {
      throw e;
    }
  }
  close({
    closeCode = 1000,
    reason = ""
  } = {}) {
    //if (navigator.userAgent.includes("Node")) {
     // this.#handleCloseEvent({
     //   code: closeCode,
     //   reason
     // });
    //} //else {
      this.#ws.close(closeCode, reason);
   // }
  }
}

//export { WebSocketStreamImpl }

//if (!Object.hasOwn(globalThis, "WebSocketStream")) {
globalThis.WebSocketStream = class WebSocketStream
extends WebSocketStreamImpl {};
//}

var u8 = new Uint8Array(1024 ** 2 * 20).fill(1);
var decoder = new TextDecoder();
var encoder = new TextEncoder();
var abortable = new AbortController;
var { signal } = abortable;

var wss = new WebSocketStream("ws://127.0.0.1:8080", {signal});
console.log(wss);

var {
  readable,
  writable
} = await wss.opened.catch(console.warn);

var reader = readable.getReader();
var writer = writable.getWriter();

Promise.allSettled([writable.closed, readable.closed, wss.closed]).then((
  [, , {
    value
  }],
) => console.log(value)).catch(console.error);

async function stream(data) {
  const len = 65536;
  let bytes = 0;

  if (typeof data === "string") {
    for (let i = 0; i < data.length; i += len) {
      await writer.ready;
      await writer.write(data.slice(i, i + len));
      const {
        value,
        done
      } = await reader.read();
      bytes += value.length;
    }
  } else {
    for (let i = 0; i < data.length; i += len) {
      const uint8 = data.subarray(i, i + len);
      await writer.ready;
      await writer.write(uint8);
      const {
        value,
        done
      } = await reader.read();
      bytes += value.byteLength;
    }
  }
  return bytes;
}

var binaryResult = await stream(u8).catch((e) => e);
var textResult = await stream("text").catch((e) => e);

console.log({
  binaryResult,
  textResult,
});

wss.close({
  closeCode: 4999,
  reason: "Done streaming",
});
