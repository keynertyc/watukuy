import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Engine, PollerMap } from '../core/engine-types.ts';
import { ConfigError, WatukuyError } from '../core/errors.ts';
import type { StateStore } from '../core/store-types.ts';
import { VERSION } from '../core/version.ts';

/** I/O and environment hooks for `runCli`, injectable for tests and embedding. */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Resolve when the process should stop (`run` command). Defaults to SIGINT/SIGTERM. */
  waitForStop?: (() => Promise<void>) | undefined;
  /** Override module loading (tests). */
  loadModule?: ((path: string) => Promise<unknown>) | undefined;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

type AnyEngine = Engine<PollerMap>;

const HELP = `watukuy ${VERSION} — webhooks for APIs that don't have them

Usage: watukuy <command> [options]

Commands (need --config, a module exporting the engine):
  inspect                 Print state of every poller/partition
  tick                    Run one poll pass over due pollers and exit (cron / serverless)
  run                     Start the engine and poll until SIGINT/SIGTERM
  trigger                 Poll now                       --poller <name> [--partition <key>]
  pause | resume          Pause/resume a poller          --poller <name> [--partition <key>]
  backfill                Start a backfill lane          --poller <name> --from <cursor|null> [--to <cursor>] [--force] [--partition <key>]
  replay                  Re-emit logged events          --poller <name> --from <iso|ms> [--to <iso|ms>] [--partition <key>]
  reset-cursor            Rewind the live cursor         --poller <name> --to <cursor|null> [--clear-snapshot] [--partition <key>]
  parked ls|retry|discard Manage parked events           --poller <name> [--ids a,b] [--kind poison|invalid] [--partition <key>]
  migrate                 Create/upgrade store tables    (with --config, or --store sqlite --path <file> | --store postgres --url <dsn>)

Options:
  -c, --config <path>     Module exporting \`engine\` (default export or named). Default: ./watukuy.config.{ts,mts,js,mjs}
  --json                  Machine-readable output
  --max-duration <dur>    tick: cooperative time budget (e.g. 50s)
  -h, --help              Show help
  -v, --version           Show version

The config module can export: \`export default engine\`, \`export const engine = createWatukuy(...)\`,
or \`export default { engine }\`. Written in TypeScript, it runs directly on Node >= 22.18 / 24.
`;

function isEngine(value: unknown): value is AnyEngine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnyEngine).tick === 'function' &&
    typeof (value as AnyEngine).inspect === 'function'
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findConfig(cwd: string, explicit: string | undefined): Promise<string> {
  if (explicit) {
    const p = resolve(cwd, explicit);
    if (!(await exists(p))) throw new ConfigError(`config not found: ${p}`);
    return p;
  }
  for (const name of [
    'watukuy.config.ts',
    'watukuy.config.mts',
    'watukuy.config.js',
    'watukuy.config.mjs',
  ]) {
    const p = resolve(cwd, name);
    if (await exists(p)) return p;
  }
  throw new ConfigError(
    'no config found: pass --config <path> or create ./watukuy.config.ts exporting the engine',
  );
}

async function loadEngine(
  io: CliIo,
  cwd: string,
  configPath: string | undefined,
): Promise<AnyEngine> {
  const path =
    io.loadModule && configPath ? resolve(cwd, configPath) : await findConfig(cwd, configPath);
  const load = io.loadModule ?? ((p: string) => import(pathToFileURL(p).href));
  const mod = (await load(path)) as Record<string, unknown>;
  const candidates = [
    mod.default,
    mod.engine,
    (mod.default as Record<string, unknown> | undefined)?.engine,
  ];
  for (const c of candidates) if (isEngine(c)) return c;
  throw new ConfigError(
    `${path} must export the engine (default export, \`engine\`, or \`{ engine }\`)`,
  );
}

async function storeFromFlags(values: Record<string, unknown>): Promise<StateStore> {
  const kind = values.store as string | undefined;
  if (kind === 'sqlite') {
    const path = values.path as string | undefined;
    if (!path) throw new ConfigError('--store sqlite requires --path <file>');
    const { SqliteStore } = await import('../stores/sqlite/index.ts');
    return new SqliteStore({ path });
  }
  if (kind === 'postgres') {
    const url = values.url as string | undefined;
    if (!url) throw new ConfigError('--store postgres requires --url <connection string>');
    const pgModule = (await import('pg')) as unknown as {
      default?: { Pool: new (o: { connectionString: string }) => unknown };
      Pool?: new (o: { connectionString: string }) => unknown;
    };
    const Pool = pgModule.Pool ?? pgModule.default?.Pool;
    if (!Pool) throw new ConfigError('could not load `pg`; install it with your package manager');
    const { PostgresStore } = await import('../stores/postgres/index.ts');
    const opts: { client: unknown; schema?: string; tablePrefix?: string } = {
      client: new Pool({ connectionString: url }),
    };
    if (typeof values.schema === 'string') opts.schema = values.schema;
    if (typeof values.prefix === 'string') opts.tablePrefix = values.prefix;
    return new PostgresStore(opts as never);
  }
  throw new ConfigError(
    'migrate needs --config, or --store sqlite --path <file>, or --store postgres --url <dsn>',
  );
}

function out(io: CliIo, json: boolean, value: unknown, human: () => string): void {
  io.stdout(json ? JSON.stringify(value, null, 2) : human());
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Run the CLI with the given argv (without the node/script prefix). Returns the exit code.
 * Exposed for tests and for embedding (`watukuy/cli`).
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const parse = () =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        json: { type: 'boolean', default: false },
        poller: { type: 'string' },
        partition: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        ids: { type: 'string' },
        kind: { type: 'string' },
        force: { type: 'boolean', default: false },
        'clear-snapshot': { type: 'boolean', default: false },
        'max-duration': { type: 'string' },
        store: { type: 'string' },
        path: { type: 'string' },
        url: { type: 'string' },
        schema: { type: 'string' },
        prefix: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse();
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    io.stderr('run `watukuy --help` for usage');
    return 2;
  }
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }
  const [command, sub] = positionals;
  if (values.help || !command) {
    io.stdout(HELP);
    return values.help ? 0 : 1;
  }

  const requirePoller = (): string => {
    const p = values.poller;
    if (typeof p !== 'string' || p.length === 0)
      throw new ConfigError(`${command} requires --poller <name>`);
    return p;
  };
  const partOpts = (): { partition?: string } =>
    typeof values.partition === 'string' ? { partition: values.partition } : {};
  const cursorArg = (raw: string | undefined, flag: string): string | null => {
    if (raw === undefined) throw new ConfigError(`${command} requires ${flag} <cursor|null>`);
    return raw === 'null' ? null : raw;
  };

  try {
    if (command === 'migrate' && !values.config && values.store) {
      const store = await storeFromFlags(values as Record<string, unknown>);
      try {
        await store.migrate();
      } finally {
        await store.close();
      }
      out(io, json, { ok: true }, () => 'migrations applied');
      return 0;
    }

    const engine = await loadEngine(io, cwd, values.config);
    switch (command) {
      case 'migrate': {
        await engine.migrate();
        out(io, json, { ok: true }, () => 'migrations applied');
        return 0;
      }
      case 'inspect': {
        const report = await engine.inspect();
        out(io, json, report, () => {
          const lines = [`instance ${report.instanceId} (${report.status})`];
          for (const p of report.pollers) {
            const name = p.partition ? `${p.poller}/${p.partition}` : p.poller;
            lines.push(
              `${name.padEnd(32)} circuit=${p.schedule.circuit.padEnd(9)} paused=${String(p.paused).padEnd(5)} ` +
                `items=${String(p.items).padEnd(7)} pending=${String(p.outboxPending).padEnd(5)} parked=${String(p.parked).padEnd(4)} ` +
                `lag=${fmtMs(p.lagMs).padEnd(7)} next=${p.schedule.nextDueAt ? new Date(p.schedule.nextDueAt).toISOString() : '-'}` +
                (p.lease ? ` lease=${p.lease.owner}#${p.lease.epoch}` : '') +
                (p.schedule.lastError ? `\n  last error: ${p.schedule.lastError.message}` : ''),
            );
          }
          return lines.join('\n');
        });
        return 0;
      }
      case 'tick': {
        const result = await engine.tick(
          typeof values['max-duration'] === 'string'
            ? { maxDuration: values['max-duration'] as never }
            : {},
        );
        out(io, json, result, () => {
          const lines = result.polled.map(
            (p) =>
              `${p.poller}${p.partition ? `/${p.partition}` : ''} [${p.lane}] items=${p.items} events=${p.events} delivered=${p.delivered} ${fmtMs(p.durationMs)}` +
              (p.error ? ` ERROR ${p.error.message}` : ''),
          );
          lines.push(
            `${result.polled.length} polled, ${result.skippedNotDue} not due, ${result.skippedLeased} leased elsewhere, ${fmtMs(result.durationMs)}${result.timedOut ? ' (timed out)' : ''}`,
          );
          return lines.join('\n');
        });
        return result.polled.some((p) => p.error) ? 1 : 0;
      }
      case 'run': {
        await engine.start();
        io.stderr(`watukuy ${VERSION} running as ${engine.instanceId}; press Ctrl+C to stop`);
        await (io.waitForStop ?? defaultWaitForStop)();
        io.stderr('stopping (draining in-flight deliveries)...');
        await engine.stop({ drain: true });
        return 0;
      }
      case 'trigger': {
        await engine.trigger(requirePoller(), partOpts());
        out(io, json, { ok: true }, () => 'triggered');
        return 0;
      }
      case 'pause': {
        await engine.pause(requirePoller(), partOpts());
        out(io, json, { ok: true }, () => 'paused');
        return 0;
      }
      case 'resume': {
        await engine.resume(requirePoller(), partOpts());
        out(io, json, { ok: true }, () => 'resumed');
        return 0;
      }
      case 'backfill': {
        const opts: Parameters<AnyEngine['backfill']>[1] = {
          from: cursorArg(values.from, '--from'),
          force: values.force === true,
          ...partOpts(),
        };
        if (values.to !== undefined) opts.to = values.to === 'null' ? null : values.to;
        await engine.backfill(requirePoller(), opts);
        out(io, json, { ok: true }, () => 'backfill lane started');
        return 0;
      }
      case 'replay': {
        if (values.from === undefined) throw new ConfigError('replay requires --from <iso|ms>');
        const toTime = (v: string): string | number => (/^\d+$/.test(v) ? Number(v) : v);
        const opts: Parameters<AnyEngine['replay']>[1] = {
          from: toTime(values.from),
          ...partOpts(),
        };
        if (values.to !== undefined) opts.to = toTime(values.to);
        const r = await engine.replay(requirePoller(), opts);
        out(io, json, r, () => `${r.replayed} events queued for replay`);
        return 0;
      }
      case 'reset-cursor': {
        await engine.resetCursor(requirePoller(), {
          to: cursorArg(values.to, '--to'),
          clearSnapshot: values['clear-snapshot'] === true,
          ...partOpts(),
        });
        out(io, json, { ok: true }, () => 'cursor reset');
        return 0;
      }
      case 'parked': {
        const name = requirePoller();
        const ids = typeof values.ids === 'string' ? values.ids.split(',').filter(Boolean) : [];
        if (sub === 'ls' || sub === undefined) {
          const opts: { partition?: string; kind?: 'poison' | 'invalid' } = { ...partOpts() };
          if (values.kind === 'poison' || values.kind === 'invalid') opts.kind = values.kind;
          const rows = await engine.parked.list(name, opts);
          out(io, json, rows, () =>
            rows.length === 0
              ? 'no parked events'
              : rows
                  .map(
                    (r) =>
                      `${r.id}  ${r.kind.padEnd(7)} ${new Date(r.parkedAt).toISOString()} attempts=${r.attempts} ` +
                      `${r.event ? `${r.event.type} ${r.event.subject}` : 'invalid item'}  ${r.error.message}`,
                  )
                  .join('\n'),
          );
          return 0;
        }
        if (sub === 'retry') {
          if (ids.length === 0) throw new ConfigError('parked retry requires --ids a,b');
          const n = await engine.parked.retry(name, ids, partOpts());
          out(io, json, { retried: n }, () => `${n} parked events moved back to the outbox`);
          return 0;
        }
        if (sub === 'discard') {
          if (ids.length === 0) throw new ConfigError('parked discard requires --ids a,b');
          const n = await engine.parked.discard(name, ids, partOpts());
          out(io, json, { discarded: n }, () => `${n} parked events discarded`);
          return 0;
        }
        throw new ConfigError(`unknown parked subcommand '${sub}' (use ls, retry, discard)`);
      }
      default:
        io.stderr(`unknown command '${command}'`);
        io.stdout(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof WatukuyError) {
      io.stderr(`error (${err.code}): ${err.message}`);
      return 1;
    }
    io.stderr(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  }
}

function defaultWaitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}
