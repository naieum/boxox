/**
 * Envelope encryption for stored secrets.
 *
 * master key (Worker secret, base64 32 bytes)
 *   └─ wraps → per-record data key (random 32 bytes)
 *                └─ encrypts → secret plaintext
 *
 * Rotating the master key only requires re-wrapping data keys.
 * Plaintext keys exist only transiently inside a request.
 */

const ALG = "AES-GCM";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  wrappedDataKey: string;
  wrapIv: string;
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, ALG, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importMasterKey(base64: string): Promise<CryptoKey> {
  const raw = fromB64(base64);
  if (raw.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  }
  return importAesKey(raw);
}

export async function encryptSecret(
  masterKey: CryptoKey,
  plaintext: string,
): Promise<EncryptedSecret> {
  const dataKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await importAesKey(dataKeyRaw);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALG, iv: iv as BufferSource },
    dataKey,
    new TextEncoder().encode(plaintext),
  );

  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDataKey = await crypto.subtle.encrypt(
    { name: ALG, iv: wrapIv as BufferSource },
    masterKey,
    dataKeyRaw as BufferSource,
  );

  return {
    ciphertext: toB64(ciphertext),
    iv: toB64(iv),
    wrappedDataKey: toB64(wrappedDataKey),
    wrapIv: toB64(wrapIv),
  };
}

export async function decryptSecret(
  masterKey: CryptoKey,
  record: EncryptedSecret,
): Promise<string> {
  const dataKeyRaw = await crypto.subtle.decrypt(
    { name: ALG, iv: fromB64(record.wrapIv) as BufferSource },
    masterKey,
    fromB64(record.wrappedDataKey) as BufferSource,
  );
  const dataKey = await importAesKey(new Uint8Array(dataKeyRaw));
  const plaintext = await crypto.subtle.decrypt(
    { name: ALG, iv: fromB64(record.iv) as BufferSource },
    dataKey,
    fromB64(record.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
