#!/usr/bin/env node
// Regenerates data/commands.json from the MT DevOps Framework's own
// auto-generated COMMANDS.md, so the extension's command catalog never
// has to be hand-maintained in a second place. Run manually (`npm run
// sync-commands`) whenever the framework's command list changes -- the
// output is committed like any other extension asset, since CI packages
// this repo standalone and has no checkout of the framework repo to read
// COMMANDS.md from at build time.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sourcePath =
  process.env.MT_COMMANDS_MD ||
  path.resolve(__dirname, "../../../../mt-devops-framework/COMMANDS.md");

const outputPath = path.resolve(__dirname, "../data/commands.json");

const ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/;
const CATEGORY_PATTERN = /^###\s+(.+)$/;

function parseCommandsMd(text) {
  const commands = [];
  const seenIds = new Set();
  let category = "Uncategorized";

  for (const line of text.split("\n")) {
    const categoryMatch = line.match(CATEGORY_PATTERN);
    if (categoryMatch) {
      category = categoryMatch[1].trim();
      continue;
    }

    const rowMatch = line.match(ROW_PATTERN);
    if (!rowMatch) continue;

    const [, command, description] = rowMatch;
    let id = `mtDevops.catalog.${command.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    while (seenIds.has(id)) id += "_";
    seenIds.add(id);

    commands.push({ id, command, description, category });
  }

  return commands;
}

const source = readFileSync(sourcePath, "utf8");
const commands = parseCommandsMd(source);

if (commands.length === 0) {
  console.error(`No commands parsed from ${sourcePath} -- refusing to overwrite ${outputPath}.`);
  process.exit(1);
}

writeFileSync(outputPath, `${JSON.stringify(commands, null, 2)}\n`);
console.log(`Wrote ${commands.length} commands to ${outputPath} (source: ${sourcePath})`);
