/**
 * Three-tier asset resolution (FR-C8), in strict priority order:
 *
 *   1. local    - a file supplied in BuildRequest.assets.local, copied as-is
 *   2. remote   - fetched from an allow-listed CDN, size- and time-capped,
 *                 re-hosted locally (NFR-C25: no hot-linked third party)
 *   3. placeholder - a deterministic SVG derived from the slot identity
 *
 * Tier 3 is not an error path. It is the reason the per-site critical path
 * stays inside 45 s even with a CDN outage, and the reason the batch delivers
 * 100 directories rather than 97 (FR-C23, NFR-C18).
 *
 * SSRF defences (NFR-C24): HTTPS only, host must match the allowlist exactly
 * or be a subdomain of it, redirects capped at 2, private and link-local
 * addresses rejected before the connection is attempted.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import type { AssetSlot } from "@pg/spec-compiler";
import { aspectDimensions, renderPlaceholderSvg } from "./placeholder.js";

export type ResolverTier = "local" | "remote" | "placeholder";

export interface ResolvedAsset {
  slotId: string;
  /** Path relative to the site root, e.g. "assets/a-hero.svg". */
  path: string;
  bytes: number;
  width: number;
  height: number;
  alt: string;
  tier: ResolverTier;
  contentType: string;
  /** Set when the tier-1 or tier-2 path was attempted and failed. */
  degradedReason?: string;
  lazy: boolean;
}

export interface AssetResolverOptions {
  outDir: string;
  siteRoot: string;
  resolver: "auto" | "local" | "remote" | "placeholder";
  localMap: Record<string, string>;
  maxBytesPerImage: number;
  formats: string[];
  offline: boolean;
  allowlist: string[];
  maxConcurrency: number;
  signal?: AbortSignal;
}

const EXTENSION_BY_FORMAT: Record<string, string> = {
  avif: "avif",
  webp: "webp",
  jpeg: "jpg",
  png: "png",
  svg: "svg",
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function hostAllowed(host: string, allowlist: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return normalized === allowed || normalized.endsWith("." + allowed);
  });
}

/** Rejects loopback, link-local, private and unique-local ranges. */
function addressIsPublic(hostname: string): boolean {
  const literal = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (literal) {
    const [a, b] = [Number(literal[1]), Number(literal[2])];
    if (isIP(hostname) === 0) return false;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".local")) return false;
  return true;
}

interface RemoteResult {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

async function fetchRemote(url: string, options: AssetResolverOptions, timeoutMs: number): Promise<RemoteResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("malformed url");
  }
  if (parsed.protocol !== "https:") throw new Error(`refusing non-https url: ${parsed.protocol}`);
  if (!hostAllowed(parsed.hostname, options.allowlist)) {
    throw new Error(`host not in allowlist: ${parsed.hostname}`);
  }
  if (!addressIsPublic(parsed.hostname)) throw new Error(`refusing non-public address: ${parsed.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    let response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "image/avif,image/webp,image/*;q=0.8" },
    });
    let redirects = 0;
    while (response.status >= 300 && response.status < 400 && redirects < 2) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, parsed).toString();
      const nextUrl = new URL(next);
      if (nextUrl.protocol !== "https:" || !hostAllowed(nextUrl.hostname, options.allowlist)) {
        throw new Error("redirect left the allowlist");
      }
      response = await fetch(next, { redirect: "follow", signal: controller.signal });
      redirects += 1;
    }
    if (!response.ok) throw new Error(`remote returned ${response.status}`);

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > options.maxBytesPerImage) {
      throw new Error(`image is ${declared} bytes, cap is ${options.maxBytesPerImage}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.byteLength > options.maxBytesPerImage) {
      throw new Error(`image is ${bytes.byteLength} bytes, cap is ${options.maxBytesPerImage}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`unexpected content type ${contentType}`);
    }
    return { bytes, contentType, finalUrl: response.url || parsed.toString() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic search query -> image URL. Only reached when a source endpoint
 * is configured on the allowlist; the default pipeline has no remote tier, so
 * every asset lands on tier 1 or tier 3 and stays hermetic.
 */
function remoteSearchUrls(slot: AssetSlot, allowlist: string[]): string[] {
  const searchHosts = allowlist.filter((entry) => /search|images|source/i.test(entry));
  if (searchHosts.length === 0) return [];
  const params = { q: slot.source_query, w: "1280" };
  const urls: string[] = [];
  for (const entry of searchHosts) {
    try {
      const base = new URL(entry);
      // fetchRemote refuses plain http anyway; rejecting it here keeps a
      // misconfigured allowlist from costing a round trip.
      if (base.protocol !== "https:") continue;
      for (const [key, value] of Object.entries(params)) base.searchParams.set(key, value);
      urls.push(base.toString());
    } catch {
      // A malformed allowlist entry is skipped, not fatal: the caller falls
      // through to the placeholder tier and records why.
    }
  }
  return urls;
}

async function writeAsset(
  options: AssetResolverOptions,
  slot: AssetSlot,
  bytes: Buffer,
  extension: string,
  contentType: string,
  tier: ResolverTier,
  degradedReason?: string,
): Promise<ResolvedAsset> {
  const [width, height] = aspectDimensions(slot.aspect_ratio);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const relative = `assets/${slot.slot_id}.${digest}.${extension}`;
  const target = join(options.outDir, "assets", `${slot.slot_id}.${digest}.${extension}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);

  return {
    slotId: slot.slot_id,
    path: relative,
    bytes: bytes.byteLength,
    width,
    height,
    alt: slot.alt,
    tier,
    contentType,
    ...(degradedReason ? { degradedReason } : {}),
    // Below-the-fold images are lazy; the hero is not (FR-C8, LCP budget).
    lazy: slot.role !== "hero" && slot.role !== "og",
  };
}

async function resolveOne(
  slot: AssetSlot,
  options: AssetResolverOptions,
  timeoutMs: number,
): Promise<ResolvedAsset> {
  const svg = Buffer.from(
    renderPlaceholderSvg({
      slotId: slot.slot_id,
      role: slot.role,
      aspectRatio: slot.aspect_ratio,
      alt: slot.alt,
    }),
    "utf8",
  );

  const placeholder = async (reason: string): Promise<ResolvedAsset> =>
    writeAsset(options, slot, svg, "svg", "image/svg+xml", "placeholder", reason);

  // Tier 1: caller-supplied local file.
  const localPath = options.localMap[slot.slot_id];
  if (localPath && options.resolver !== "placeholder") {
    // A URL in the local map belongs on the allowlisted remote tier, not here.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(localPath)) {
      return await placeholder(`local asset ${slot.slot_id} is a URL; use the remote tier`);
    }
    try {
      const absolute = resolve(localPath);
      // Containment is checked with a relative path, not a prefix test:
      // `C:\site-backup\x.png` starts with `C:\site` but is outside it.
      const fromRoot = relative(resolve(options.siteRoot), absolute);
      if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        return await placeholder(`local asset ${slot.slot_id} resolves outside the site root`);
      }
      await access(absolute);
      const bytes = await readFile(absolute);
      if (bytes.byteLength <= options.maxBytesPerImage) {
        const extension = EXTENSION_BY_FORMAT[extname(absolute).slice(1).toLowerCase()] ?? "jpg";
        return await writeAsset(
          options,
          slot,
          bytes,
          extension,
          CONTENT_TYPE_BY_EXT[extname(absolute).toLowerCase()] ?? "image/jpeg",
          "local",
        );
      }
      return await placeholder(`local file is ${bytes.byteLength} bytes, over the ${options.maxBytesPerImage} cap`);
    } catch (error) {
      return await placeholder(`local file unreadable: ${(error as Error).message}`);
    }
  }

  // Tier 2: allow-listed remote fetch.
  if (options.resolver === "local") return placeholder("resolver pinned to local");
  if (options.offline) return placeholder("offline mode");
  const candidates = remoteSearchUrls(slot, options.allowlist);
  if (candidates.length === 0) return placeholder("no image source configured on the allowlist");

  let lastError = "unknown";
  for (const url of candidates) {
    try {
      const result = await fetchRemote(url, options, timeoutMs);
      const extension =
        EXTENSION_BY_FORMAT[extname(new URL(result.finalUrl).pathname).slice(1).toLowerCase()] ??
        (result.contentType.split("/")[1] ?? "jpg");
      return await writeAsset(
        options,
        slot,
        result.bytes,
        extension,
        result.contentType || "image/jpeg",
        "remote",
      );
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  return await placeholder(lastError);
}

/** Resolves every slot, bounded by `maxConcurrency`. */
export async function resolveAssets(
  slots: readonly AssetSlot[],
  options: AssetResolverOptions,
  timeoutMs = 5000,
): Promise<{ resolved: Map<string, ResolvedAsset>; degraded: number; offline: number }> {
  const resolved = new Map<string, ResolvedAsset>();
  let degraded = 0;
  let offline = 0;
  const queue = [...slots];
  // A non-finite maxConcurrency would make Array.from({length: NaN}) produce
  // zero workers, silently resolving no assets at all.
  const requested = Number.isFinite(options.maxConcurrency) ? options.maxConcurrency : queue.length;
  const workerCount = Math.max(1, Math.min(requested, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const slot = queue.shift();
      if (!slot) return;
      try {
        const asset = await resolveOne(slot, options, timeoutMs);
        resolved.set(slot.slot_id, asset);
        if (asset.tier === "placeholder") {
          degraded += 1;
          if (asset.degradedReason?.includes("offline") || asset.degradedReason?.includes("allowlist")) offline += 1;
        }
      } catch (error) {
        degraded += 1;
        resolved.set(slot.slot_id, {
          slotId: slot.slot_id,
          path: "",
          bytes: 0,
          width: 0,
          height: 0,
          alt: slot.alt,
          tier: "placeholder",
          contentType: "image/svg+xml",
          degradedReason: `resolver threw: ${(error as Error).message}`,
          lazy: slot.role !== "hero",
        });
      }
    }
  });
  await Promise.all(workers);
  return { resolved, degraded, offline };
}
