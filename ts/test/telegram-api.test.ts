/**
 * Tests for splitText() — pure text chunking logic (no network).
 */

import { describe, test, expect } from "bun:test";
import { splitText } from "../lib/telegram-api.js";

describe("splitText", () => {
  test("returns single chunk when text is within limit", () => {
    const result = splitText("Hello world", 4096);
    expect(result).toEqual(["Hello world"]);
  });

  test("returns single chunk for exactly limit-length text", () => {
    const text = "x".repeat(4096);
    const result = splitText(text, 4096);
    expect(result).toEqual([text]);
  });

  test("splits on paragraph boundary when available", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(2000);
    const text = `${first}\n\n${second}`;
    const result = splitText(text, 4096);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  test("splits on line boundary when no paragraph break", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(2000);
    const text = `${first}\n${second}`;
    const result = splitText(text, 4096);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  test("splits on space when no newline available", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(2000);
    const text = `${first} ${second}`;
    const result = splitText(text, 4096);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(first);
    // Space remains at start of second chunk (only newlines are stripped)
    expect(result[1]).toBe(` ${second}`);
  });

  test("hard-splits when no whitespace available", () => {
    const text = "x".repeat(5000);
    const result = splitText(text, 4096);
    expect(result.length).toBe(2);
    expect(result[0]).toBe("x".repeat(4096));
    expect(result[1]).toBe("x".repeat(904));
  });

  test("handles multiple chunks", () => {
    const text = "x".repeat(10000);
    const result = splitText(text, 4096);
    expect(result.length).toBe(3);
    expect(result.join("")).toBe(text);
  });

  test("returns empty array element for empty string", () => {
    const result = splitText("");
    expect(result).toEqual([""]);
  });

  test("uses default MAX_TEXT (4096) when no limit provided", () => {
    const text = "a".repeat(4096);
    const result = splitText(text);
    expect(result.length).toBe(1);
  });

  test("strips leading newlines from subsequent chunks", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(2000);
    const text = `${first}\n\n\n\n${second}`;
    const result = splitText(text, 4096);
    expect(result.length).toBe(2);
    // The second chunk should not start with newlines
    expect(result[1].startsWith("\n")).toBe(false);
    expect(result[1]).toBe(second);
  });

  test("prefers paragraph break over line break", () => {
    // Place a paragraph break at position ~2500 and a line break later at ~2900
    const beforePara = "a".repeat(2500);
    const betweenParaAndLine = "b".repeat(400);
    const afterLine = "c".repeat(2000);
    const text = `${beforePara}\n\n${betweenParaAndLine}\n${afterLine}`;
    const result = splitText(text, 4096);
    // Should split at paragraph boundary since it's past limit/2
    expect(result.length).toBe(2);
    expect(result[0]).toBe(beforePara);
  });
});
