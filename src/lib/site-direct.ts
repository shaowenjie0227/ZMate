import { invoke } from "@tauri-apps/api/core";

import type { CoreEnvelope } from "@/types";

/** 「IP 直连站点」的三个已知入口：主域名 + 两台直连 IP（与 Rust 侧常量一致）。 */
export const SITE_DIRECT_ORIGINS = {
  domain: "https://aispot.swj0227.icu",
  ipPrimary: "http://38.207.166.83",
  ipFallback: "http://149.88.72.47",
} as const;

export interface SiteDirectPingResult {
  label: string;
  origin: string;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface SiteDirectStatusPayload {
  directActive: boolean;
  currentOrigin: string | null;
  settingsBaseUrl: string;
  providerMatches: number;
}

export interface SiteDirectApplyPayload {
  targetOrigin: string;
  settingsUpdated: boolean;
  providersUpdated: number;
  backupPath: string | null;
  effectiveBaseUrl: string;
}

export const siteDirectApi = {
  status: () => invoke<CoreEnvelope<SiteDirectStatusPayload>>("site_direct_status"),

  ping: (label: string, origin: string) =>
    invoke<CoreEnvelope<SiteDirectPingResult>>("site_direct_ping", { label, origin }),

  apply: (targetOrigin: string) =>
    invoke<CoreEnvelope<SiteDirectApplyPayload>>("site_direct_apply", { targetOrigin }),
};
