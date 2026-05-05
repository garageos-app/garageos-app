/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COGNITO_OFFICINE_POOL_ID: string;
  readonly VITE_COGNITO_OFFICINE_CLIENT_ID: string;
  readonly VITE_COGNITO_REGION: string;
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
