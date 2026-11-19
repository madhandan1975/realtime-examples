import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gluePath = path.join(
  root,
  "node_modules/@audio/encode-opus/src/opus.wasm.js",
);

// Import the emscripten factory and capture wasmBinary before Workers-forbidden compile.
const { default: createModule } = await import(pathToFileURL(gluePath).href);

let captured = null;
try {
  await createModule({
    instantiateWasm(imports, receiveInstance) {
      // Embind/emscripten sets this.wasmBinary (or the closure's wasmBinary)
      // before calling instantiateWasm in some builds; in others the binary is
      // only an argument to instantiateAsync. Hook both via a Proxy env.
      throw new Error("stop-before-compile");
    },
  });
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("stop-before-compile")) {
    // Fall through — we'll try the wasmBinary hook below.
    console.warn("createModule probe:", error instanceof Error ? error.message : error);
  }
}

// Second strategy: patch WebAssembly.instantiate to steal the buffer.
const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = async (bytesOrModule, imports) => {
  if (bytesOrModule instanceof ArrayBuffer || ArrayBuffer.isView(bytesOrModule)) {
    captured = bytesOrModule instanceof ArrayBuffer
      ? new Uint8Array(bytesOrModule)
      : new Uint8Array(
          bytesOrModule.buffer,
          bytesOrModule.byteOffset,
          bytesOrModule.byteLength,
        );
    // Still compile in Node so the module finishes initializing if needed.
    return originalInstantiate(captured, imports);
  }
  if (bytesOrModule instanceof WebAssembly.Module) {
    return originalInstantiate(bytesOrModule, imports);
  }
  return originalInstantiate(bytesOrModule, imports);
};

await createModule({});
WebAssembly.instantiate = originalInstantiate;

if (!captured) {
  throw new Error("Failed to capture wasmBinary from @audio/encode-opus");
}

const wasm =
  captured instanceof Uint8Array
    ? captured
    : new Uint8Array(captured);

if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
  throw new Error(`Not a Wasm binary: magic=${[...wasm.slice(0, 4)]}`);
}

await WebAssembly.compile(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

const outDir = path.join(root, "src/server/vendor");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "opus.wasm");
fs.writeFileSync(outPath, wasm);
// Copy emscripten glue so we do not rely on a non-exported package subpath.
const glueSrc = path.join(
  root,
  "node_modules/@audio/encode-opus/src/opus.wasm.js",
);
const glueDest = path.join(outDir, "opus-emscripten.js");
fs.copyFileSync(glueSrc, glueDest);
console.log(`Wrote ${outPath} (${wasm.byteLength} bytes)`);
console.log(`Wrote ${glueDest}`);
