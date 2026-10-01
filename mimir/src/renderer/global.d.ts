import type { MimirApi } from "./bridge";

declare global {
  interface Window {
    mimir: MimirApi;
  }
}

export {};
