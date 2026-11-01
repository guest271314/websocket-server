//! https://github.com/dy/jz/issues/111#issuecomment-6544755304
import { WASI } from "node:wasi";
import { readFileSync } from "node:fs";
const wasi = new WASI({ version: "preview1" });
const inst = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(process.argv[2])),
  wasi.getImportObject(),
);
wasi.finalizeBindings(inst);
inst.exports._initialize?.();
inst.exports._start?.();
