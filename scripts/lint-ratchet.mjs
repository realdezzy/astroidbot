#!/usr/bin/env node
/**
 * Lint ratchet.
 *
 * ESLint errors must be zero — that's the hard gate. Warnings are pre-existing
 * debt (`no-explicit-any` at untyped SDK boundaries, `no-console`); they are
 * allowed to exist but never to grow. The accepted ceiling lives in
 * .lint-baseline.json and this script fails CI if the count rises above it.
 *
 * When you reduce the count, run `node scripts/lint-ratchet.mjs --update` and
 * commit the new baseline so the improvement is locked in.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASELINE_PATH = new URL("../.lint-baseline.json", import.meta.url);

let raw;
try {
  raw = execSync("npx eslint src tests --format json", {
    maxBuffer: 1024 * 1024 * 128,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  // eslint exits non-zero when it reports errors; the JSON is still on stdout.
  raw = e.stdout;
  if (!raw) {
    console.error("eslint failed to produce a report:\n" + (e.stderr || e.message));
    process.exit(2);
  }
}

const report = JSON.parse(raw);
const errors = report.reduce((n, f) => n + f.errorCount, 0);
const warnings = report.reduce((n, f) => n + f.warningCount, 0);

const byRule = {};
for (const f of report) {
  for (const m of f.messages) {
    const k = m.ruleId ?? "parse-error";
    byRule[k] = (byRule[k] ?? 0) + 1;
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ maxWarnings: warnings, byRule, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
  console.log(`baseline updated: ${warnings} warnings`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : { maxWarnings: Infinity };

console.log(`eslint: ${errors} error(s), ${warnings} warning(s) (ceiling ${baseline.maxWarnings})`);
for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${rule}`);
}

if (errors > 0) {
  console.error(`\n✖ ${errors} lint error(s). Errors are a hard gate — fix them.`);
  process.exit(1);
}

if (warnings > baseline.maxWarnings) {
  console.error(
    `\n✖ warnings rose from ${baseline.maxWarnings} to ${warnings}. ` +
      `Fix the new ones, or run 'node scripts/lint-ratchet.mjs --update' if the increase is deliberate.`
  );
  process.exit(1);
}

if (warnings < baseline.maxWarnings) {
  console.log(
    `\n✔ warnings fell from ${baseline.maxWarnings} to ${warnings}. ` +
      `Run 'node scripts/lint-ratchet.mjs --update' to lock the improvement in.`
  );
}

console.log("\n✔ lint gate passed");
