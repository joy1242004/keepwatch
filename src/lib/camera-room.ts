const ROOM_TOKEN_BYTES = 24;
const ROOM_TOKEN_PATTERN = /^[0-9a-f]{48}$/i;

export function createRoomToken(): string {
  const bytes = new Uint8Array(ROOM_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseRoomToken(value: string): string | null {
  const trimmed = value.trim();

  try {
    const parsed = new URL(trimmed);
    const urlToken = parsed.searchParams.get("room");
    if (urlToken && ROOM_TOKEN_PATTERN.test(urlToken)) return urlToken.toLowerCase();
  } catch {
    // A pasted room token is also a valid, more compact input.
  }

  return ROOM_TOKEN_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function createViewerLink(origin: string, token: string): string {
  const url = new URL(origin);
  url.searchParams.set("room", token);
  return url.toString();
}