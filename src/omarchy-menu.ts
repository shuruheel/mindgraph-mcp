import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser";

const rows: Record<string, { label: string; action?: string }> = {
  mindgraph: { label: "MindGraph" },
  "mindgraph.remember": { label: "Remember this", action: "omarchy-launch-tui mindgraph-mcp desktop remember --from-menu" },
  "mindgraph.recall": { label: "Recall", action: "omarchy-launch-tui mindgraph-mcp desktop recall --from-menu" },
  "mindgraph.resume": { label: "Resume project", action: "omarchy-launch-tui mindgraph-mcp desktop resume --from-menu" },
};

// Omarchy strips whole-line comments and accepts trailing commas. Keeping a
// recognizable block lets uninstall preserve every byte of neighboring entries.
const marker = "// MindGraph desktop menu";
function menuBlock(includeParent: boolean): string {
  const entries = Object.entries(rows).filter(([id]) => includeParent || id !== "mindgraph");
  return [
    "", "  " + marker,
    ...entries.map(([id, row]) => `  "${id}": ${JSON.stringify(row)},`),
    "  // End MindGraph desktop menu", "",
  ].join("\n");
}

export function updateMenu(install: boolean, configHome = path.join(os.homedir(), ".config")): string {
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
  let next = original;
  const block = [menuBlock(true), menuBlock(false)].find(text => original.includes(text));
  if (block) {
    if (!install) {
      // A custom child still needs its submenu after our actions are removed.
      const keepParent = block === menuBlock(true) && ids.some(id => id.startsWith("mindgraph.") && !Object.hasOwn(rows, id));
      next = original.replace(block, keepParent ? '\n  "mindgraph": {"label":"MindGraph"},\n' : "");
    }
  } else if (original.includes(marker)) {
    throw new Error(`The MindGraph menu block in ${menu} was edited. Review or remove that block manually.`);
  } else if (install) {
    const submenu = findNodeAtLocation(parent, ["mindgraph"]);
    const useExistingParent = submenu?.type === "object" &&
      !["action", "target", "provider"].some(field => findNodeAtLocation(submenu, [field]));
    const collision = ids.find(id => Object.hasOwn(rows, id) && !(id === "mindgraph" && useExistingParent));
    if (collision) throw new Error(`Menu entry ${collision} already exists in ${menu}.`);
    const afterBrace = parent.offset + 1;
    next = original.slice(0, afterBrace) + menuBlock(!useExistingParent) + original.slice(afterBrace);
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
