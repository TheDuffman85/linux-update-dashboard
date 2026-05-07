declare const __APP_VERSION__: string;
declare const __APP_BUILD_DATE__: string;
declare const __APP_COMMIT_HASH__: string;
declare const __APP_BRANCH__: string;
declare const __APP_REPO_URL__: string;

interface ImportMetaEnv {
  readonly VITE_MIN_SCHEDULE_INTERVAL_MINUTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
