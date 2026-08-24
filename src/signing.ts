/**
 * HMAC-SHA256 over a string, shared by everything the Worker signs: the session
 * cookie and the OAuth state cookie. Both are values handed to a browser and
 * taken back on trust, so both need the same treatment.
 */

export async function sign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * crypto.subtle.verify compares in constant time. Comparing signatures with
 * `!==` would short-circuit on the first differing character and leak how much
 * of a forgery was right.
 */
export async function verify(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const bytes = base64UrlDecode(signature);
  if (bytes === null) return false;

  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    bytes,
    new TextEncoder().encode(payload),
  );
}

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Reads one cookie out of a `Cookie` header. */
export function cookieValue(
  header: string | null,
  name: string,
): string | null {
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }

  return null;
}
