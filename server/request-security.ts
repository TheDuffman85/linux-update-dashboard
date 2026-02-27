import type { Context } from "hono";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { config } from "./config";
import { getRequestIp } from "./request-ip-store";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function normalizedPort(url: URL): string {
  return url.port || defaultPort(url.protocol);
}

function isLoopbackIp(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("127.")) return true;
  if (lower.startsWith("::ffff:127.")) return true;
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTS.has(host)) return true;
  return isLoopbackIp(host);
}

function getCanonicalOrigin(): URL {
  const parsed = parseOrigin(config.baseUrl);
  if (parsed) return parsed;
  return new URL("http://localhost:3001");
}

function isTrustedOriginUrl(candidate: URL): boolean {
  const canonical = getCanonicalOrigin();
  const canonicalHost = normalizeHost(canonical.hostname);
  const candidateHost = normalizeHost(candidate.hostname);

  // In local/dev mode, allow same loopback host family across ports.
  if (isLoopbackHost(canonicalHost) && isLoopbackHost(candidateHost)) {
    return candidate.protocol === "http:" || candidate.protocol === "https:";
  }

  return (
    candidate.protocol === canonical.protocol &&
    candidateHost === canonicalHost &&
    normalizedPort(candidate) === normalizedPort(canonical)
  );
}

function getHeaderOrigin(c: Context): URL | null {
  const origin = c.req.header("origin");
  if (origin) {
    const parsed = parseOrigin(origin);
    if (parsed) return parsed;
  }

  const referer = c.req.header("referer");
  if (referer) {
    const parsed = parseOrigin(referer);
    if (parsed) return new URL(parsed.origin);
  }

  return null;
}

function pickProto(c: Context): string {
  if (config.trustProxy) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto === "https" || proto === "http") return `${proto}:`;
  }

  try {
    return new URL(c.req.url).protocol;
  } catch {
    return "http:";
  }
}

function pickHost(c: Context): string | null {
  if (config.trustProxy) {
    const forwardedHost = c.req.header("x-forwarded-host");
    if (forwardedHost) return forwardedHost.split(",")[0].trim();
  }
  return c.req.header("host") ?? null;
}

export function getTrustedPublicOrigin(c: Context): string {
  const headerOrigin = getHeaderOrigin(c);
  if (headerOrigin && isTrustedOriginUrl(headerOrigin)) {
    return headerOrigin.origin;
  }

  const host = pickHost(c);
  if (host) {
    const parsed = parseOrigin(`${pickProto(c)}//${host}`);
    if (parsed && isTrustedOriginUrl(parsed)) {
      return parsed.origin;
    }
  }

  return getCanonicalOrigin().origin;
}

export function isTrustedReturnOrigin(value: string): boolean {
  const parsed = parseOrigin(value);
  if (!parsed) return false;
  return isTrustedOriginUrl(parsed);
}

export function getClientIp(c: Context): string | null {
  const directIp = getRequestIp(c.req.raw);
  if (directIp) return directIp.trim();

  if (config.trustProxy) {
    const forwarded =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip")?.trim();
    if (forwarded) return forwarded;
  }

  return null;
}

export function isLoopbackRequest(c: Context): boolean {
  const ip = getClientIp(c);
  if (!ip) return false;
  return isLoopbackIp(ip);
}

function isPrivateOrReservedIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true;

  return false;
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("2001:db8:")) return true; // documentation
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (isIP(mapped) === 4) {
      return isPrivateOrReservedIPv4(mapped);
    }
  }
  return false;
}

export function isPrivateOrReservedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateOrReservedIPv4(address);
  if (version === 6) return isPrivateOrReservedIPv6(address);
  return true;
}

export async function isSafeOutboundUrl(rawUrl: string): Promise<{ safe: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { safe: false, reason: "URL must use http or https" };
  }

  const hostname = normalizeHost(parsed.hostname);
  if (!hostname) return { safe: false, reason: "URL hostname is required" };

  if (isLoopbackHost(hostname)) {
    return { safe: false, reason: "URL must not point to loopback addresses" };
  }
  if (hostname === "metadata.google.internal") {
    return { safe: false, reason: "URL must not point to internal metadata services" };
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { safe: false, reason: "URL must not point to private or reserved IP addresses" };
    }
    return { safe: true };
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (!records.length) {
      return { safe: false, reason: "Hostname did not resolve to an IP address" };
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        return { safe: false, reason: "URL hostname resolves to private or reserved IP addresses" };
      }
    }
  } catch {
    return { safe: false, reason: "Unable to resolve URL hostname" };
  }

  return { safe: true };
}
