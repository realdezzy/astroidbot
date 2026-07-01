import { describe, it, expect } from "vitest";
import { isValidEmail, isValidPassword, STACKS_ADDRESS_REGEX, STACKS_PRIVATE_KEY_REGEX } from "../../shared/validation.js";

describe("Shared validation utils", () => {
  describe("isValidEmail", () => {
    it("should accept valid email formats", () => {
      expect(isValidEmail("test@example.com")).toBe(true);
      expect(isValidEmail("user.name+tag@sub.domain.co.uk")).toBe(true);
    });

    it("should reject invalid email formats", () => {
      expect(isValidEmail("plain")).toBe(false);
      expect(isValidEmail("@missing-local.org")).toBe(false);
      expect(isValidEmail("missing-domain@")).toBe(false);
      expect(isValidEmail("spaces in@email.com")).toBe(false);
    });
  });

  describe("isValidPassword", () => {
    it("should accept passwords meeting constraints", () => {
      expect(isValidPassword("Pass12345")).toBe(true);
      expect(isValidPassword("a1b2c3d4e5f")).toBe(true);
    });

    it("should reject passwords that are too short", () => {
      expect(isValidPassword("Short1")).toBe(false); // 6 chars
    });

    it("should reject passwords lacking letters", () => {
      expect(isValidPassword("123456789")).toBe(false);
    });

    it("should reject passwords lacking numbers", () => {
      expect(isValidPassword("abcdefghij")).toBe(false);
    });
  });

  describe("Regex rules", () => {
    it("should match valid Stacks address format", () => {
      const address = "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2";
      expect(STACKS_ADDRESS_REGEX.test(address)).toBe(true);
    });

    it("should reject invalid Stacks address formats", () => {
      expect(STACKS_ADDRESS_REGEX.test("SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J")).toBe(false); // too short
      expect(STACKS_ADDRESS_REGEX.test("APMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2")).toBe(false); // wrong prefix
    });

    it("should match valid Stacks private key", () => {
      const key = "e10d21e25de82da03c623200231c2048197c87cccf474aefb8ecf6f8cc0b12ea";
      expect(STACKS_PRIVATE_KEY_REGEX.test(key)).toBe(true);
    });

    it("should reject invalid Stacks private keys", () => {
      expect(STACKS_PRIVATE_KEY_REGEX.test("e10d21e25de82da03c623200231c2048197c87cccf474aefb8ecf6f8cc0b12e")).toBe(false); // too short
      expect(STACKS_PRIVATE_KEY_REGEX.test("g10d21e25de82da03c623200231c2048197c87cccf474aefb8ecf6f8cc0b12ea")).toBe(false); // non-hex
    });
  });
});
