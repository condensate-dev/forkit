#!/usr/bin/env node
/**
 * The `forkit` command. `forkit explore [run]` serves the run explorer (see docs/guides/explore.md).
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileRunId, startExploreServer } from "./server.ts";
import { isRunId, listRuns, recordDir } from "./store.ts";

const HELP = `forkit explore [run] [options]

Serve a local, read-only explorer over forkit run records.

  run            a run id (from .forkit/runs), "latest", or a path to a run record .json
                 (default: the run list)

Options:
  --dir <path>   record directory (default: $FORKIT_RECORD_DIR, else ./.forkit)
  --port <n>     port to listen on (default: a free port)
  -h, --help     show this help

Record a run first: FORKIT_RECORD=1 <your test command>.`;

async function explore(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  const dir = resolve(values.dir ?? recordDir());
  const target = positionals[0];
  const files: string[] = [];
  let open: string | undefined;
  if (target !== undefined) {
    if (target === "latest") {
      open = listRuns(dir)[0]?.id;
      if (open === undefined) {
        console.error(`forkit: no runs in ${dir}. Record one with FORKIT_RECORD=1.`);
        return 1;
      }
    } else if (existsSync(target) && statSync(target).isFile()) {
      // Open this file's run, not the newest one: the record dir is served too, and may hold
      // newer runs.
      files.push(resolve(target));
      open = fileRunId(resolve(target));
    } else if (isRunId(target)) {
      open = target;
    } else {
      console.error(`forkit: ${target} is neither a run id nor a run record file.`);
      return 1;
    }
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`forkit: --port must be a port number, got ${values.port}`);
    return 1;
  }
  const server = await startExploreServer({ dir, files, port });
  const url = open === undefined ? server.url : `${server.url}#/run/${encodeURIComponent(open)}`;
  console.log(`forkit explore: ${url}`);
  const serving = files.length > 0 ? `${files.join(", ")}, and the runs in ${dir}` : dir;
  console.log(`  serving ${serving} (read-only). Ctrl-C to stop.`);
  const stop = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return await new Promise<number>(() => {});
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "explore") return await explore(rest);
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    console.log(
      `forkit <command>\n\nCommands:\n  explore [run]   serve the run explorer\n\n${HELP}`,
    );
    return command === undefined ? 1 : 0;
  }
  console.error(`forkit: unknown command ${JSON.stringify(command)}. Try \`forkit explore\`.`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
