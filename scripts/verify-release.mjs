#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const status = git(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
assert(!status, `release source is dirty:\n${status}`);

const branch = git(["branch", "--show-current"]).trim();
assert(branch === "main", `release must be prepared from main, found ${branch || "detached HEAD"}`);
const head = git(["rev-parse", "HEAD"]).trim();
const remote = git(["remote", "get-url", "origin"]).trim();
assert(remote === "git@github.com:raririn/mypi-cli.git"
  || remote === "https://github.com/raririn/mypi-cli.git",
  `unexpected public release remote: ${remote}`);

const reportPath = join(root, "dist", "npm", "npm-package-report.json");
assert(existsSync(reportPath), "release package report is missing");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert(report.sourceDirty === false, "release artifact was built from dirty source");

const artifact = join(root, "dist", "npm", report.filename);
const provenance = JSON.parse(
  execFileSync("tar", ["-xOzf", artifact, "package/MYPI_PROVENANCE.json"], { encoding: "utf8" }),
);
assert(provenance.sourceCommit === head, "release artifact does not identify current HEAD");
assert(provenance.sourceDirty === false, "release artifact provenance records dirty source");
assert(provenance.npmPackage === "@raririn/mypi", "release artifact has unexpected npm identity");

console.log(`Release-ready from ${head}: ${report.filename} (${report.sha256}).`);

function git(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
