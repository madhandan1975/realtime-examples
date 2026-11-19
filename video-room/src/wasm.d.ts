declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module "*opus-emscripten.js" {
  type EmscriptenFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;
  const createModule: EmscriptenFactory;
  export default createModule;
}
