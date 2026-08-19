/**
 * lib/api-root.ts — the resolution + validation of the Telegram API root.
 *
 * These are pure, env-injected unit tests of resolveApiRoot(). The behaviour
 * that MATTERS (a real process actually talking to a real redirected server)
 * is proven in test/api-base-seam.test.ts, which imports nothing from lib/ so
 * that it can go red on behaviour rather than on a missing symbol. This file
 * pins the contract around that: defaults, normalisation, and the refusals.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveApiRoot,
  DEFAULT_API_ROOT,
  TelegramApiBaseError,
  API_ROOT,
} from "../lib/api-root.js";
import { API_BASE, FILE_BASE } from "../lib/config.js";

describe("resolveApiRoot — default", () => {
  test("unset resolves to Telegram's own API, byte-for-byte", () => {
    expect(resolveApiRoot({})).toBe("https://api.telegram.org");
    expect(DEFAULT_API_ROOT).toBe("https://api.telegram.org");
  });

  test('an EMPTY value counts as ABSENT (a folded ""-secret must not throw)', () => {
    expect(resolveApiRoot({ CCT_TELEGRAM_API_BASE: "" })).toBe(
      DEFAULT_API_ROOT,
    );
  });

  test("the process-wide API_ROOT is the default under the hermetic preload", () => {
    // preload.ts sets no override, so the live consts must be unchanged from
    // the hardcoded literals they replaced. This is the no-regression pin.
    expect(API_ROOT).toBe(DEFAULT_API_ROOT);
    expect(API_BASE).toBe("https://api.telegram.org/botfake:token");
    expect(FILE_BASE).toBe("https://api.telegram.org/file/botfake:token");
  });
});

describe("resolveApiRoot — accepted overrides", () => {
  test("the short CCT_ spelling wins and is honoured verbatim", () => {
    expect(resolveApiRoot({ CCT_TELEGRAM_API_BASE: "http://127.0.0.1:8081" })).toBe(
      "http://127.0.0.1:8081",
    );
  });

  test("the canonical long spelling works too", () => {
    expect(
      resolveApiRoot({
        CLAUDE_CODE_TELEGRAMMER_TELEGRAM_API_BASE: "https://tg.internal",
      }),
    ).toBe("https://tg.internal");
  });

  test("a trailing slash is stripped, so no call site ever builds //getUpdates", () => {
    expect(resolveApiRoot({ CCT_TELEGRAM_API_BASE: "http://127.0.0.1:8081/" })).toBe(
      "http://127.0.0.1:8081",
    );
  });

  test("a path PREFIX survives (a reverse-proxied Bot API server)", () => {
    expect(
      resolveApiRoot({ CCT_TELEGRAM_API_BASE: "https://gw.internal/telegram/" }),
    ).toBe("https://gw.internal/telegram");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(resolveApiRoot({ CCT_TELEGRAM_API_BASE: "  http://127.0.0.1:9  " })).toBe(
      "http://127.0.0.1:9",
    );
  });
});

describe("resolveApiRoot — refusals are LOUD and name the variable + value", () => {
  const bad = (value: string): (() => string) => () =>
    resolveApiRoot({ CCT_TELEGRAM_API_BASE: value });

  test("a non-URL throws TelegramApiBaseError naming the var and the value", () => {
    let caught: unknown;
    try {
      bad("not a url")();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TelegramApiBaseError);
    const message = (caught as Error).message;
    expect(message).toContain("CCT_TELEGRAM_API_BASE");
    expect(message).toContain("CLAUDE_CODE_TELEGRAMMER_TELEGRAM_API_BASE");
    expect(message).toContain('"not a url"');
    // Actionable: says what shape is wanted and how to get the default back.
    expect(message).toContain("http://127.0.0.1:8081");
    expect(message).toContain(DEFAULT_API_ROOT);
  });

  test("a relative path throws (no host to send a token to)", () => {
    expect(bad("/telegram")).toThrow(TelegramApiBaseError);
  });

  test("whitespace-only throws — it is a typo, not an opt-out", () => {
    expect(bad("   ")).toThrow(TelegramApiBaseError);
  });

  test("a non-http scheme throws", () => {
    expect(bad("ftp://tg.internal")).toThrow(/scheme/);
    expect(bad("file:///tmp/x")).toThrow(TelegramApiBaseError);
  });

  test("embedded credentials throw", () => {
    expect(bad("http://user:pw@127.0.0.1:8081")).toThrow(/credentials/);
  });

  test("a query string throws — it would land mid-path", () => {
    expect(bad("http://127.0.0.1:8081/?x=1")).toThrow(/query/);
  });

  test("a #fragment throws — it is never sent to a server", () => {
    expect(bad("http://127.0.0.1:8081/#frag")).toThrow(/fragment/);
  });

  test('passing the FULL base (with "/bot<token>") throws, pointing at the fix', () => {
    // The variable is named ..._API_BASE, so pasting the whole base is the
    // obvious mistake; it would silently produce /bot<token>/bot<token>/getUpdates.
    expect(bad("http://127.0.0.1:8081/bot123:ABC")).toThrow(/bot<token>/);
  });

  test("NO refusal ever returns the real API instead — every bad value throws", () => {
    for (const value of [
      "not a url",
      "/telegram",
      "   ",
      "ftp://tg.internal",
      "http://user:pw@127.0.0.1:8081",
      "http://127.0.0.1:8081/?x=1",
      "http://127.0.0.1:8081/#frag",
      "http://127.0.0.1:8081/bot123:ABC",
    ]) {
      let threw = false;
      try {
        resolveApiRoot({ CCT_TELEGRAM_API_BASE: value });
      } catch {
        threw = true;
      }
      expect(`${value} threw=${threw}`).toBe(`${value} threw=true`);
    }
  });
});
