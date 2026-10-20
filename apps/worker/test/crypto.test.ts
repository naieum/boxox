import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importMasterKey } from "../src/crypto";

function randomMasterKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

describe("envelope encryption", () => {
  it("round-trips a secret", async () => {
    const master = await importMasterKey(randomMasterKeyB64());
    const enc = await encryptSecret(master, "re_test_1234567890abcdef");
    expect(enc.ciphertext).not.toContain("re_test");
    const dec = await decryptSecret(master, enc);
    expect(dec).toBe("re_test_1234567890abcdef");
  });

  it("produces unique ciphertexts and data keys per call", async () => {
    const master = await importMasterKey(randomMasterKeyB64());
    const a = await encryptSecret(master, "same-secret");
    const b = await encryptSecret(master, "same-secret");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it("fails to decrypt with the wrong master key", async () => {
    const master = await importMasterKey(randomMasterKeyB64());
    const other = await importMasterKey(randomMasterKeyB64());
    const enc = await encryptSecret(master, "secret");
    await expect(decryptSecret(other, enc)).rejects.toThrow();
  });

  it("rejects master keys that are not 32 bytes", async () => {
    await expect(importMasterKey(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});
