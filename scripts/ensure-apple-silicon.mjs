import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "darwin") process.exit(0);

if (process.arch !== "arm64") {
  throw new Error(
    `Сбер Атлас требует нативный ARM64 Node на macOS; сейчас запущен ${process.arch}. ` +
      "Откройте нативный терминал и выполните `nvm use`."
  );
}

const root = process.cwd();
const removeNamedEntries = (relativeDirectory, shouldRemove) => {
  const directory = join(root, relativeDirectory);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (shouldRemove(entry)) rmSync(join(directory, entry), { recursive: true, force: true });
  }
};

// Some native packages publish every platform prebuild in one archive. Keep only
// the Apple Silicon binary so an x64 addon can never be loaded by this checkout.
removeNamedEntries("node_modules/better-sqlite3/prebuilds", (name) => name !== "darwin-arm64.node");
removeNamedEntries("node_modules/better-sqlite3/lib", (name) => /(?:^|-)x64(?:\.|-)/i.test(name));

for (const directory of ["node_modules/@next", "node_modules/@esbuild", "node_modules/@img"]) {
  removeNamedEntries(directory, (name) => /(?:^|-)x64(?:$|\.|-)/i.test(name));
}

const fsevents = join(root, "node_modules/fsevents/fsevents.node");
if (existsSync(fsevents)) {
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", fsevents], { encoding: "utf8" }).trim().split(/\s+/);
  if (!architectures.includes("arm64")) throw new Error("fsevents не содержит ARM64-срез.");
  if (architectures.length > 1) {
    const output = `${fsevents}.arm64`;
    const mode = statSync(fsevents).mode;
    execFileSync("/usr/bin/lipo", [fsevents, "-thin", "arm64", "-output", output]);
    chmodSync(output, mode);
    renameSync(output, fsevents);
  }
}

console.log("Apple Silicon check: ARM64 Node and native dependencies only.");
