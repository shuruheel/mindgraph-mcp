import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser";

type MenuRow = { label: string; action?: string };

const defaultRows: Record<string, MenuRow> = {
  mindgraph: { label: "MindGraph" },
  "mindgraph.remember": { label: "Remember this", action: "omarchy-launch-tui mindgraph-mcp desktop remember --from-menu" },
  "mindgraph.recall": { label: "Recall", action: "omarchy-launch-tui mindgraph-mcp desktop recall --from-menu" },
  "mindgraph.setup": { label: "Set up MindGraph", action: "omarchy-launch-tui mindgraph-mcp desktop setup --from-menu" },
  "mindgraph.resume": { label: "Resume project", action: "omarchy-launch-tui mindgraph-mcp desktop resume --from-menu" },
};

const signedOutRows: Record<string, MenuRow> = {
  mindgraph: { label: "MindGraph" },
  "mindgraph.connect": { label: "Connect", action: "omarchy-launch-tui mindgraph-mcp desktop setup --from-menu" },
};

const connectedRows: Record<string, MenuRow> = {
  mindgraph: { label: "MindGraph" },
  "mindgraph.dashboard": { label: "Dashboard", action: "mindgraph-mcp desktop dashboard" },
  "mindgraph.resume": { label: "Resume work", action: "omarchy-launch-tui mindgraph-mcp desktop resume --from-menu" },
  "mindgraph.remember": { label: "Remember this", action: "omarchy-launch-tui mindgraph-mcp desktop remember --from-menu" },
  "mindgraph.recall": { label: "Recall", action: "omarchy-launch-tui mindgraph-mcp desktop recall --from-menu" },
  "mindgraph.widgets": { label: "Desktop widgets", action: "omarchy-launch-tui mindgraph-mcp desktop widgets --from-menu" },
  "mindgraph.disconnect": { label: "Disconnect", action: "omarchy-launch-tui mindgraph-mcp desktop disconnect --from-menu" },
};

const ALL_OWNED_IDS = new Set([
  ...Object.keys(defaultRows),
  ...Object.keys(signedOutRows),
  ...Object.keys(connectedRows),
]);

// Omarchy strips whole-line comments and accepts trailing commas. Keeping a
// recognizable block lets uninstall preserve every byte of neighboring entries.
const marker = "// MindGraph desktop menu";

function formatBlock(rows: Record<string, MenuRow>, includeParent: boolean): string {
  const entries = Object.entries(rows).filter(([id]) => includeParent || id !== "mindgraph");
  return [
    "", "  " + marker,
    ...entries.map(([id, row]) => `  "${id}": ${JSON.stringify(row)},`),
    "  // End MindGraph desktop menu", "",
  ].join("\n");
}

function legacyDefaultRows(): Record<string, MenuRow> {
  return Object.fromEntries(Object.entries(defaultRows).filter(([id]) => id !== "mindgraph.setup"));
}

function targetRowsFor(options?: { connected?: boolean }): Record<string, MenuRow> {
  if (options?.connected === true) return connectedRows;
  if (options?.connected === false) return signedOutRows;
  return defaultRows;
}

function knownBlocks(): Array<{ text: string; includeParent: boolean; ids: string[] }> {
  const rowSets = [defaultRows, legacyDefaultRows(), connectedRows, signedOutRows];
  const blocks: Array<{ text: string; includeParent: boolean; ids: string[] }> = [];
  for (const rows of rowSets) {
    for (const includeParent of [true, false]) {
      blocks.push({
        text: formatBlock(rows, includeParent),
        includeParent,
        ids: Object.keys(rows).filter(id => includeParent || id !== "mindgraph"),
      });
    }
  }
  return blocks;
}

export function updateMenu(
  install: boolean,
  configHome = path.join(os.homedir(), ".config"),
  options?: { connected?: boolean },
): string {
  const menu = path.join(configHome, "omarchy/extensions/omarchy-menu.jsonc");
  if (!install && !fs.existsSync(menu)) return "Menu already removed.";
  fs.mkdirSync(path.dirname(menu), { recursive: true });
  // Follow an existing dotfile symlink so a Stow-managed menu stays linked.
  const existing = fs.lstatSync(menu, { throwIfNoEntry: false });
  const target = existing ? fs.realpathSync(menu) : menu;
  const original = existing ? fs.readFileSync(target, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const tree = parseTree(original, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== "object") throw new Error(`Invalid JSONC object in ${menu}`);
  const items = findNodeAtLocation(tree, ["items"]);
  const parent = items?.type === "object" ? items : tree;
  const ids = (parent.children ?? []).map(property => String(property.children?.[0].value));
  const targetRows = targetRowsFor(options);
  let next = original;
  const matched = knownBlocks().find(candidate => original.includes(candidate.text));
  if (matched) {
    if (install) {
      const desired = formatBlock(targetRows, matched.includeParent);
      if (matched.text !== desired) {
        const previousOwned = new Set(matched.ids);
        const newIds = Object.keys(targetRows).filter(id => (matched.includeParent || id !== "mindgraph") && !previousOwned.has(id));
        const collision = newIds.find(id => ids.includes(id));
        if (collision) throw new Error(`Menu entry ${collision} already exists.`);
        next = original.replace(matched.text, desired);
      }
    } else {
      // A custom child still needs its submenu after our actions are removed.
      const keepParent = matched.includeParent && ids.some(id => id.startsWith("mindgraph.") && !ALL_OWNED_IDS.has(id));
      next = original.replace(matched.text, keepParent ? '\n  "mindgraph": {"label":"MindGraph"},\n' : "");
    }
  } else if (original.includes(marker)) {
    throw new Error(`The MindGraph menu block in ${menu} was edited. Review or remove that block manually.`);
  } else if (install) {
    const submenu = findNodeAtLocation(parent, ["mindgraph"]);
    const useExistingParent = submenu?.type === "object" &&
      !["action", "target", "provider"].some(field => findNodeAtLocation(submenu, [field]));
    const collision = ids.find(id => Object.hasOwn(targetRows, id) && !(id === "mindgraph" && useExistingParent));
    if (collision) throw new Error(`Menu entry ${collision} already exists in ${menu}.`);
    const afterBrace = parent.offset + 1;
    next = original.slice(0, afterBrace) + formatBlock(targetRows, !useExistingParent) + original.slice(afterBrace);
  }
  if (next === original) return install ? "Menu already installed." : "Menu already removed.";
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, next, { flag: "wx", mode: existing ? fs.statSync(target).mode & 0o777 : 0o600 });
    if (existing) {
      if (fs.readFileSync(target, "utf8") !== original) throw new Error("Menu changed during installation. Try again.");
      fs.renameSync(temp, target);
    } else {
      fs.linkSync(temp, target);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return `${install ? "Installed" : "Removed"} MindGraph entries in ${menu}.`;
}
