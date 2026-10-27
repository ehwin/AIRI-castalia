/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISTRIBUTION?: 'direct' | 'steam'
  readonly VITE_DISABLE_CUSTOM_PROVIDERS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
