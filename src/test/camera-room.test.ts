import { describe, expect, it } from "vitest";

import { createRoomToken, createViewerLink, parseRoomToken } from "@/lib/camera-room";

describe("camera room links", () => {
  it("creates an unguessable 48-character hexadecimal room key", () => {
    expect(createRoomToken()).toMatch(/^[0-9a-f]{48}$/);
  });

  it("accepts a room key pasted by itself or from a viewer link", () => {
    const token = "a1b2c3d4e5f678901234567890abcdef1234567890abcdef";

    expect(parseRoomToken(token)).toBe(token);
    expect(parseRoomToken(createViewerLink("https://keepwatch.example", token))).toBe(token);
  });

  it("rejects inputs that do not contain a valid room key", () => {
    expect(parseRoomToken("abc123")).toBeNull();
    expect(parseRoomToken("https://keepwatch.example/?room=not-a-key")).toBeNull();
  });
});