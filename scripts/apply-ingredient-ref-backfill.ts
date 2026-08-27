import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

import {
  generateBackfillSql,
  parseBackfillExport,
} from "./ingredient-ref-backfill.ts";

const options = parseArgs(process.argv.slice(2));
assertGeneratedPath(options.exportPath, "--export", true);
assertGeneratedPath(options.marks, "--marks", true);
assertGeneratedPath(options.output, "--output", false);
const exported = parseBackfillExport(JSON.parse(readFileSync(options.exportPath, "utf8")));
const marks: unknown = JSON.parse(readFileSync(options.marks, "utf8"));
const result = generateBackfillSql(exported, marks);
writePrivateFile(options.output, result.sql);
console.error(
  `wrote ${result.updatedSteps} update(s) to ${options.output}; ` +
  `${result.acceptedMarks} mark(s) accepted, ${result.droppedMarks} dropped`,
);

function parseArgs(args: string[]): { exportPath: string; marks: string; output: string } {
  let exportPath = "";
  let marks = "";
  let output = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--export") exportPath = valueAfter(args, ++index, arg);
    else if (arg === "--marks") marks = valueAfter(args, ++index, arg);
    else if (arg === "--output") output = valueAfter(args, ++index, arg);
    else throw new Error(`unknown apply argument: ${arg}`);
  }
  if (!exportPath) throw new Error("--export is required");
  if (!marks) throw new Error("--marks is required");
  if (!output) throw new Error("--output is required");
  return { exportPath, marks, output };
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function assertGeneratedPath(path: string, label: string, existing: boolean): void {
  const generated = resolve(".generated");
  const target = resolve(path);
  if (!target.startsWith(`${generated}${sep}`)) {
    throw new Error(`${label} must be under .generated/`);
  }
  if (lstatSync(generated).isSymbolicLink()) throw new Error(".generated/ must not be a symlink");
  const realGenerated = realpathSync(generated);
  const realParent = realpathSync(dirname(target));
  if (realParent !== realGenerated && !realParent.startsWith(`${realGenerated}${sep}`)) {
    throw new Error(`${label} must not traverse a symlink outside .generated/`);
  }
  if (existing) {
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(`${realGenerated}${sep}`)) {
      throw new Error(`${label} must not be a symlink outside .generated/`);
    }
  }
}

function writePrivateFile(path: string, contents: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents, "utf8");
  } finally {
    closeSync(fd);
  }
}
