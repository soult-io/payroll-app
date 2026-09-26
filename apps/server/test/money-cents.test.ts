/**
 * PAY-91 (spec 23 §6): exact NUMERIC(12,2) <-> integer-cents conversion used
 * by the state deposit planner. No floats on this path.
 */
import { describe, expect, it } from "vitest";
import { formatCents, parseCents } from "@payroll/shared";

describe("parseCents", () => {
  it("parses 2dp strings exactly", () => {
    expect(parseCents("123.45")).toBe(12345);
    expect(parseCents("0.00")).toBe(0);
    expect(parseCents("0.01")).toBe(1);
    expect(parseCents("9999999999.99")).toBe(999999999999);
    expect(parseCents("-5.10")).toBe(-510);
  });
  it("accepts 0 or 1 decimals (NUMERIC text forms)", () => {
    expect(parseCents("5")).toBe(500);
    expect(parseCents("5.5")).toBe(550);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "1.234", "1,00", "$1.00", " 1.00", "1e2", "abc", "-", ".50"]) {
      expect(() => parseCents(bad), bad).toThrow();
    }
  });
});

describe("formatCents", () => {
  it("formats integer cents as a 2dp string", () => {
    expect(formatCents(12345)).toBe("123.45");
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(7)).toBe("0.07");
    expect(formatCents(-510)).toBe("-5.10");
  });
  it("round-trips", () => {
    for (const c of [0, 1, 99, 100, 2655, 37690, 999999999999]) {
      expect(parseCents(formatCents(c))).toBe(c);
    }
  });
  it("rejects non-integers", () => {
    expect(() => formatCents(1.5)).toThrow();
  });
});
