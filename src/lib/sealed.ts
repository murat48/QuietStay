/**
 * Sealed links: a private record sent browser to browser, with no file and no
 * server storage (docs/PHASE3_SPEC.md §2, decisions D3 and D4).
 *
 * The recipient's browser makes an ECDH P-256 key pair. The private key is
 * non-extractable and stays in its IndexedDB (src/lib/vault.ts). Its raw
 * public key travels in a *request link*, and its SHA-256, the *key hash*, is
 * recorded with the ask the recipient makes, before the sender ever sees the
 * link. The sender's browser refuses to seal unless the link's key hashes to
 * that recorded value, then seals with an ephemeral key:
 *
 *   shared = ECDH(ephemeral, recipient)
 *   key    = HKDF-SHA-256(shared, salt = key hash, info = "quietstay sealed record v1")
 *   blob   = ephemeral public key (65) ‖ IV (12) ‖ AES-256-GCM(key, IV, payload, aad = key hash)
 *
 * Links carry everything after `#`, which browsers never send in any request.
 *
 *   request link: /receive#req=<kind>.<ask id>.<recipient public key, base64url>
 *   reply link:   /receive#rec=<blob, base64url>
 *
 * WebCrypto only. No new cryptography: ECDH, HKDF and AES-GCM as WebCrypto
 * implements them.
 */

const INFO = new TextEncoder().encode("quietstay sealed record v1");

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const buf = (b: Uint8Array) => b as unknown as ArrayBuffer;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** A recipient key pair. The private key cannot be exported, even by this app. */
export async function newRecipientKey(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array; keyHash: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicRaw, keyHash: await sha256Hex(publicRaw) };
}

async function aesKey(privateKey: CryptoKey, peerRaw: Uint8Array, keyHash: string): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", buf(peerRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(hexBytes(keyHash)), info: buf(INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal `payload` to the recipient key in a request link. Refuses unless the
 * key hashes to `expectedKeyHash`, the value recorded with the recipient's ask.
 */
export async function seal(recipientRaw: Uint8Array, expectedKeyHash: string, payload: unknown): Promise<string> {
  const keyHash = await sha256Hex(recipientRaw);
  if (keyHash !== expectedKeyHash) {
    throw new Error("the link's key is not the one recorded with this request; refusing to seal the record to it");
  }
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await aesKey(eph.privateKey, recipientRaw, keyHash);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: buf(hexBytes(keyHash)) },
      key,
      buf(new TextEncoder().encode(JSON.stringify(payload))),
    ),
  );
  const out = new Uint8Array(65 + 12 + ct.length);
  out.set(ephRaw, 0);
  out.set(iv, 65);
  out.set(ct, 77);
  return b64u(out);
}

/** Open a reply link's blob with the recipient's private key. */
export async function open(privateKey: CryptoKey, keyHash: string, blob: string): Promise<unknown> {
  const bytes = unb64u(blob);
  if (bytes.length < 65 + 12 + 16) throw new Error("this link is too short to be a sealed record");
  const key = await aesKey(privateKey, bytes.subarray(0, 65), keyHash);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(bytes.subarray(65, 77)), additionalData: buf(hexBytes(keyHash)) },
    key,
    buf(bytes.subarray(77)),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * `issue`: an owner's issuance ask (off-chain store). `buy`: a Phase 2 ask to
 * buy without payment (off-chain store). `offer`: Phase 3 (D4a), an on-chain
 * `RecordRequest` id, made before a paid sale offer.
 */
export type RequestKind = "issue" | "buy" | "offer";

export function requestLink(origin: string, kind: RequestKind, askId: string, publicRaw: Uint8Array): string {
  return `${origin}/receive#req=${kind}.${askId}.${b64u(publicRaw)}`;
}

export function replyLink(origin: string, blob: string): string {
  return `${origin}/receive#rec=${blob}`;
}

export type Fragment =
  | { type: "request"; kind: RequestKind; askId: string; publicRaw: Uint8Array }
  | { type: "reply"; blob: string }
  | null;

/** Read a /receive fragment. Does not touch the address bar; the page does. */
export function parseFragment(hash: string): Fragment {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (h.startsWith("req=")) {
    const [kind, askId, key] = h.slice(4).split(".");
    if ((kind !== "issue" && kind !== "buy" && kind !== "offer") || !askId || !key) {
      throw new Error("this request link is incomplete");
    }
    if (kind === "offer" && !/^\d{1,19}$/.test(askId)) throw new Error("this request link's request id is not a number");
    const publicRaw = unb64u(key);
    if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("this request link's key is not a P-256 public key");
    return { type: "request", kind, askId, publicRaw };
  }
  if (h.startsWith("rec=")) return { type: "reply", blob: h.slice(4) };
  return null;
}

/** What a reply link carries (spec §2, step 3). */
export interface SealedRecord {
  v: 1;
  record: unknown;
  /** The current holder's secret hash, decimal: needed to check `C`. */
  h: string;
  holder: string;
  right_id: number;
  contract: string;
  request: { kind: RequestKind; id: string };
}
