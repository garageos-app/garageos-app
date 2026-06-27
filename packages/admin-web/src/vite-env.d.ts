/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COGNITO_PLATFORM_ADMINS_POOL_ID: string;
  readonly VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID: string;
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
