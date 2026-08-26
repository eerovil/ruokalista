import appleTouchIcon from "../assets/pwa/generated/apple-touch-icon.png";
import icon192 from "../assets/pwa/generated/icon-192.png";
import icon512 from "../assets/pwa/generated/icon-512.png";
import maskableIcon512 from "../assets/pwa/generated/icon-maskable-512.png";
import favicon from "../assets/pwa/ruokalista-mark.svg";
import type { Handler } from "./router.ts";
import {
  MANIFEST,
  OFFLINE_PAGE,
  PWA_CLIENT_SCRIPT,
  contentGeneration,
  serviceWorkerSource,
} from "./pwa-content.ts";

const NO_CACHE = { "Cache-Control": "no-cache" };

const assets = [
  MANIFEST,
  OFFLINE_PAGE,
  PWA_CLIENT_SCRIPT,
  favicon,
  icon192,
  icon512,
  maskableIcon512,
  appleTouchIcon,
  serviceWorkerSource("CONTENT_GENERATION"),
] as const;

const generation = contentGeneration(assets);

export const manifest: Handler = () =>
  new Response(MANIFEST, {
    headers: {
      ...NO_CACHE,
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });

export const offline: Handler = () =>
  new Response(OFFLINE_PAGE, {
    headers: { ...NO_CACHE, "Content-Type": "text/html; charset=utf-8" },
  });

export const serviceWorker: Handler = async () =>
  new Response(serviceWorkerSource(await generation), {
    headers: {
      ...NO_CACHE,
      "Content-Type": "text/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    },
  });

function binary(bytes: ArrayBuffer, contentType: string): Handler {
  return () =>
    new Response(bytes, {
      headers: { ...NO_CACHE, "Content-Type": contentType },
    });
}

export const faviconIcon = binary(favicon, "image/svg+xml");
export const regularIcon192 = binary(icon192, "image/png");
export const regularIcon512 = binary(icon512, "image/png");
export const maskableIcon = binary(maskableIcon512, "image/png");
export const appleIcon = binary(appleTouchIcon, "image/png");
