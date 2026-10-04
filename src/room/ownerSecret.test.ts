import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../test/memoryStorage.ts";
import { clearOwnerSecret, readOwnerSecret, saveOwnerSecret } from "./ownerSecret.ts";

const ROOM = "R".repeat(22);
const SECRET = "s".repeat(43);

describe("owner secret storage", () => {
  it("round-trips per room and clears", () => {
    const storage = new MemoryStorage();
    saveOwnerSecret(ROOM, SECRET, storage);
    expect(readOwnerSecret(ROOM, storage)).toBe(SECRET);
    expect(readOwnerSecret("X".repeat(22), storage)).toBeUndefined();
    clearOwnerSecret(ROOM, storage);
    expect(readOwnerSecret(ROOM, storage)).toBeUndefined();
  });

  it("ignores a tampered or malformed value", () => {
    const storage = new MemoryStorage();
    storage.setItem(`poof:owner:${ROOM}`, "not a secret");
    expect(readOwnerSecret(ROOM, storage)).toBeUndefined();
  });

  it("survives storage that is missing or throws (private modes, blocked site data)", () => {
    const broken = new MemoryStorage();
    broken.getItem = () => {
      throw new Error("SecurityError");
    };
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    broken.removeItem = () => {
      throw new Error("SecurityError");
    };
    expect(() => saveOwnerSecret(ROOM, SECRET, broken)).not.toThrow();
    expect(readOwnerSecret(ROOM, broken)).toBeUndefined();
    expect(() => clearOwnerSecret(ROOM, broken)).not.toThrow();
    expect(readOwnerSecret(ROOM, null)).toBeUndefined();
  });

  it("uses sessionStorage by default, never localStorage", () => {
    saveOwnerSecret(ROOM, SECRET);
    expect(window.sessionStorage.getItem(`poof:owner:${ROOM}`)).toBe(SECRET);
    expect(window.localStorage.length).toBe(0);
    clearOwnerSecret(ROOM);
    expect(window.sessionStorage.length).toBe(0);
  });
});
