/** Room codes: short, upper-case, and free of look-alike characters (0/O, 1/I/L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function randomCode(rand: () => number = secureRandom): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return code;
}

export function isRoomCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Normalise typed or pasted input (case, spaces, dashes). Validate with `isRoomCode`. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

/** Room code from `/join/CODE` or `?room=CODE`, if the location carries one. */
export function codeFromLocation(pathname: string, search: string): string | null {
  const path = /^\/join\/([A-Za-z0-9]+)\/?$/.exec(pathname);
  const raw = path?.[1] ?? new URLSearchParams(search).get("room") ?? "";
  const code = normalizeCode(raw);
  return isRoomCode(code) ? code : null;
}

export function randomToken(bytes = 18): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function secureRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}
