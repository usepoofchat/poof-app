import { describe, expect, it } from "vitest";
import {
  NOTE_CIPHERTEXT_MAX_BYTES,
  createNoteRequestSchema,
  errorCodeSchema,
  noteCreatorRequestSchema,
  noteStatusResponseSchema,
  revealNoteRequestSchema,
} from "../src/index.ts";

const id = "A".repeat(22);
const tok = "B".repeat(43);
const valid = { id, ciphertext: "C".repeat(100), ttl: 600, creatorHash: tok, revealHash: tok };

describe("Poof Note schemas", () => {
  it("accept a well-formed note", () => {
    expect(createNoteRequestSchema.safeParse(valid).success).toBe(true);
    for (const ttl of [600, 3600, 86_400])
      expect(createNoteRequestSchema.safeParse({ ...valid, ttl }).success).toBe(true);
  });

  it("only the three lifetimes", () => {
    for (const ttl of [0, 60, 601, 7200, "600", null])
      expect(createNoteRequestSchema.safeParse({ ...valid, ttl }).success).toBe(false);
  });

  it("ciphertext: base64url, at most 16 KiB once decoded", () => {
    const max = Math.ceil((NOTE_CIPHERTEXT_MAX_BYTES * 4) / 3);
    expect(
      createNoteRequestSchema.safeParse({ ...valid, ciphertext: "a".repeat(max) }).success,
    ).toBe(true);
    expect(
      createNoteRequestSchema.safeParse({ ...valid, ciphertext: "a".repeat(max + 1) }).success,
    ).toBe(false);
    expect(createNoteRequestSchema.safeParse({ ...valid, ciphertext: "" }).success).toBe(false);
    expect(createNoteRequestSchema.safeParse({ ...valid, ciphertext: "a+b/" }).success).toBe(false);
  });

  it("ids and tokens have exact shapes", () => {
    expect(createNoteRequestSchema.safeParse({ ...valid, id: "short" }).success).toBe(false);
    expect(createNoteRequestSchema.safeParse({ ...valid, revealHash: "x" }).success).toBe(false);
    expect(revealNoteRequestSchema.safeParse({ revealToken: tok }).success).toBe(true);
    expect(revealNoteRequestSchema.safeParse({}).success).toBe(false);
    expect(noteCreatorRequestSchema.safeParse({ creatorSecret: tok }).success).toBe(true);
  });

  it("status carries a state and never content", () => {
    expect(noteStatusResponseSchema.safeParse({ state: "read", expiresAt: 1 }).success).toBe(true);
    expect(noteStatusResponseSchema.safeParse({ state: "expired" }).success).toBe(true);
    expect(noteStatusResponseSchema.safeParse({ state: "opened" }).success).toBe(false);
  });

  it("note error codes are part of the API's error set", () => {
    for (const c of ["note_gone", "note_exists", "wrong_secret"])
      expect(errorCodeSchema.safeParse(c).success).toBe(true);
  });
});
