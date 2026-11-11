#!/usr/bin/env node
// Compiles the CLI (which also contains the MCP server: `oai-image mcp`) into a
// standalone executable with Bun. No Node.js is needed to run the result.
//
//   node scripts/build-binary.mjs                      this machine  -> dist-bin/oai-image
//   node scripts/build-binary.mjs linux-arm64 ...      named targets -> dist-bin/oai-image-<target>
//   node scripts/build-binary.mjs --all                every target
//
// Cross-compiling makes Bun download the runtime for the other platform.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-arm64",
	"darwin-x64",
	"windows-x64",
];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist-bin");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write(`Usage: node scripts/build-binary.mjs [--all | <target>...]\n\nTargets: ${TARGETS.join(", ")}\n`);
	process.exit(0);
}
const requested = args.includes("--all") ? TARGETS : args.filter(arg => !arg.startsWith("-"));
const unknown = requested.filter(target => !TARGETS.includes(target));
if (unknown.length > 0) {
	process.stderr.write(`Unknown target: ${unknown.join(", ")}\nTargets: ${TARGETS.join(", ")}\n`);
	process.exit(2);
}

/** Bun from this project's dev dependencies, else from PATH. `BUN` overrides both. */
function findBun() {
	if (process.env.BUN) return process.env.BUN;
	const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "bun.exe" : "bun");
	return existsSync(local) ? local : "bun";
}

function build(target) {
	const windows = target ? target.startsWith("windows") : process.platform === "win32";
	const outfile = path.join(outDir, `oai-image${target ? `-${target}` : ""}${windows ? ".exe" : ""}`);
	const result = spawnSync(
		findBun(),
		[
			"build",
			path.join(root, "src", "cli.ts"),
			"--compile",
			// A compiled Bun executable otherwise reads `.env` and `bunfig.toml` from
			// the directory it is started in. A project's `.env` must not be able to
			// point OAI_IMAGE_BASE_URL (and the login token with it) somewhere else.
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			...(target ? [`--target=bun-${target}`] : []),
			`--outfile=${outfile}`,
		],
		{ cwd: root, stdio: ["ignore", "inherit", "inherit"] },
	);
	if (result.error) {
		process.stderr.write(`Could not run Bun (${result.error.message}). Run \`npm install\`, or set BUN to a bun executable.\n`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
	const megabytes = (statSync(outfile).size / 1024 / 1024).toFixed(0);
	process.stdout.write(`${path.relative(root, outfile)}  ${megabytes} MB\n`);
}

mkdirSync(outDir, { recursive: true });
if (requested.length === 0) build(undefined);
else for (const target of requested) build(target);
