/**
 * Stub for optional @icr/polyseg-wasm (Cornerstone Tools PolySeg worker).
 * This viewer does not use WASM segmentation; the real package is not bundled.
 */
export default class PolySegWasmStub {
  async initialize(_opts?: { updateProgress?: (p: number) => void }): Promise<void> {}
}
