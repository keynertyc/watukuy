#!/usr/bin/env node
/**
 * `watukuy` command line: operate an engine from a config module (inspect, tick, run, trigger,
 * pause, resume, backfill, replay, reset-cursor, parked) and run store migrations.
 * Importing this module programmatically (`watukuy/cli`) exposes `runCli` without executing it.
 * @packageDocumentation
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCli } from './cli.ts';

export { type CliIo, runCli } from './cli.ts';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
