/**
 * Cloudflare Workers forbid compiling Wasm from ArrayBuffer.
 * Prefer a precompiled Module import; fall back to compile() only on Node tests.
 */
import type { } from "./vendor/opus-emscripten.js";

export type OpusEmscriptenModule = {
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  _audio_opus_enc_create(sampleRate: number, channels: number, app: number): number;
  _audio_opus_enc_destroy(handle: number): void;
  _audio_opus_enc_encode(handle: number, frameSize: number): number;
  _audio_opus_enc_input(handle: number): number;
  _audio_opus_enc_last_error(): number;
  _audio_opus_enc_lookahead(handle: number): number;
  _audio_opus_enc_output(handle: number): number;
  _audio_opus_enc_set(handle: number, ctl: number, value: number): number;
};

type EmscriptenFactory = (
  moduleArg?: Record<string, unknown>,
) => Promise<OpusEmscriptenModule>;

let modulePromise: Promise<OpusEmscriptenModule> | undefined;

export function loadOpusEmscriptenModule(): Promise<OpusEmscriptenModule> {
  if (!modulePromise) {
    modulePromise = load();
  }
  return modulePromise;
}

async function load(): Promise<OpusEmscriptenModule> {
  const createModule = (
    await import("./vendor/opus-emscripten.js")
  ).default as EmscriptenFactory;
  const wasmModule = await loadWasmModule();
  return createModule({
    instantiateWasm(
      imports: WebAssembly.Imports,
      receiveInstance: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      receiveInstance(instance, wasmModule);
      return instance.exports;
    },
  });
}

async function loadWasmModule(): Promise<WebAssembly.Module> {
  try {
    return (await import("./vendor/opus.wasm")).default;
  } catch {
    // Node/tsx unit tests: compile from bytes (allowed outside Workers).
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const wasmPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "vendor/opus.wasm",
    );
    return WebAssembly.compile(readFileSync(wasmPath));
  }
}
