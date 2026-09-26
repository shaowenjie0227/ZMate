export type Route =
  | "overview"
  | "providers"
  | "apiKeys"
  | "usageLogs"
  | "wallet"
  | "mcp"
  | "skills"
  | "customInstructions"
  | "sessions"
  | "maintenance"
  | "settings"
  | "siteLogin"
  | "profile";

export const ALL_APP_ROUTES: Route[] = [
  "overview",
  "providers",
  "apiKeys",
  "usageLogs",
  "wallet",
  "mcp",
  "skills",
  "customInstructions",
  "sessions",
  "maintenance",
  "settings",
  "siteLogin",
  "profile",
];

export function isAppRoute(value: string): value is Route {
  return (ALL_APP_ROUTES as string[]).includes(value);
}
