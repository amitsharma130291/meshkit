export interface WasmModuleHandle<TExports extends WebAssembly.Exports = WebAssembly.Exports> {
  instance: WebAssembly.Instance;
  module: WebAssembly.Module;
  exports: TExports;
}

export interface WasmLoadOptions {
  /** Import object future modules may need (e.g. memory, env functions). */
  imports?: WebAssembly.Imports;
}
