import { isIP } from "node:net";

// Push subscriptions are URLs supplied by a client. Restrict destinations before
// storage and again before delivery, including legacy database subscriptions.
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (process.env.LOCAL_ONLY === "true") return false;
  try {
    if (endpoint.length > 1000 || endpoint.includes("\\") || /[\r\n\t]/.test(endpoint)) return false;
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
    const host = url.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, "")) || host === "localhost" || host.endsWith(".local") || !host.includes(".")) return false;
    const exactHosts = ["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com",
      ...(process.env.PUSH_ALLOWED_HOSTS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)];
    return exactHosts.includes(host) ||
      host === "push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") ||
      host === "notify.windows.com" || host.endsWith(".notify.windows.com");
  } catch { return false; }
}
