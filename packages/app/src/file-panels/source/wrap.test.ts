import { describe, expect, it } from "vitest";
import { shouldWrapFile } from "./wrap";

describe("shouldWrapFile", () => {
  it.each([
    ["README.md", null, true],
    ["notes.MARKDOWN", null, true],
    ["server.ts", null, false],
    ["server.ts", true, true],
    ["README.md", false, false],
  ] as const)("%s with choice %s wraps: %s", (filename, choice, expected) => {
    expect(shouldWrapFile(filename, choice)).toBe(expected);
  });
});
