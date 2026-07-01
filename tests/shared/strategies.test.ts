import { describe, it, expect } from "vitest";
import { STRATEGY_TYPES, STRATEGY_REGISTRY, STRATEGY_FIELDS, STRATEGY_DEFAULTS, STRATEGY_LABELS } from "../../shared/strategies.js";

describe("Shared strategies definition", () => {
  it("should have correct types list and registry matching", () => {
    expect(STRATEGY_TYPES.length).toBeGreaterThan(0);
    expect(STRATEGY_REGISTRY.length).toBe(STRATEGY_TYPES.length);
    
    for (const type of STRATEGY_TYPES) {
      const def = STRATEGY_REGISTRY.find((s) => s.type === type);
      expect(def).toBeDefined();
      expect(def!.label).toBeDefined();
      expect(def!.desc).toBeDefined();
      expect(def!.defaults).toBeDefined();
      expect(def!.fields).toBeDefined();
    }
  });

  it("should map fields and defaults correctly in pre-built maps", () => {
    for (const type of STRATEGY_TYPES) {
      const def = STRATEGY_REGISTRY.find((s) => s.type === type)!;
      
      const fields = STRATEGY_FIELDS[type];
      expect(fields).toBeDefined();
      expect(fields!.length).toBe(def.fields.length);
      for (const field of def.fields) {
        expect(fields).toContain(field.key);
        expect(typeof STRATEGY_LABELS[field.key]).toBe("string");
      }

      const defaults = STRATEGY_DEFAULTS[type];
      expect(defaults).toBeDefined();
      expect(defaults).toEqual(def.defaults);
    }
  });
});
