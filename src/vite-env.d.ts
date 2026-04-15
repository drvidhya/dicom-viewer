/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Path relative to the page (leading `/` ignored) or full `http(s)` URL; trailing slash optional. */
  readonly VITE_DICOM_DATA_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
