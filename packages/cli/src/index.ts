#!/usr/bin/env node

import { runCli } from './commands.js';

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
process.exitCode = exitCode;
