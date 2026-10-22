#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitHub } from "./github.ts";
import { createServer } from "./server.ts";

await createServer(createGitHub()).connect(new StdioServerTransport());
