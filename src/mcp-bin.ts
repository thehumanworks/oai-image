#!/usr/bin/env node
import { runStdioServer } from "./mcp.ts";

runStdioServer().catch((error: unknown) => {
	process.stderr.write(`oai-image-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
