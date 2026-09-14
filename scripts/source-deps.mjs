import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const stateDir = path.join(rootDir, "node_modules", ".editor-source-deps");
const dependencies = [
  {
    packageName: "@moenarch/editor-core",
    sourceEnv: "EDITOR_CORE_SOURCE",
    defaultSourceDir: path.resolve(rootDir, "../editor-core"),
    acceptedSourceNames: ["@moenarch/editor-core"],
  },
  {
    packageName: "@moritzbrantner/timeline-editor",
    sourceEnv: "TIMELINE_EDITOR_SOURCE",
    defaultSourceDir: path.resolve(rootDir, "../timeline-editor"),
    acceptedSourceNames: ["@moritzbrantner/timeline-editor"],
    prepareSourceDependencies: true,
  },
];

const command = process.argv[2] ?? "status";

if (command === "prepare") await prepare();
else if (command === "restore") await restore();
else if (command === "status") await status();
else if (command === "smoke") await smoke();
else fail(`unknown command ${JSON.stringify(command)}; use prepare, restore, status, or smoke`);

async function prepare() {
  run("bun", ["install", "--frozen-lockfile"], rootDir);
  await mkdir(stateDir, { recursive: true });
  for (const dependency of dependencies) await prepareDependency(dependency);
}

async function prepareDependency(dependency) {
  const sourceDir = resolveSourceDir(dependency);
  const manifest = await readSourceManifest(dependency, sourceDir);
  run("bun", ["install", "--frozen-lockfile"], sourceDir);

  if (dependency.prepareSourceDependencies && manifest.scripts?.["source:prepare"]) {
    run("bun", ["run", "source:prepare"], sourceDir);
  }
  if (!manifest.scripts?.build) {
    fail(`${dependency.packageName} source checkout has no build script: ${sourceDir}`);
  }
  run("bun", ["run", "build"], sourceDir);
  await materializePackage(dependency, sourceDir, manifest);

  const revision = run("git", ["rev-parse", "HEAD"], sourceDir, true).trim();
  await writeFile(
    stateFile(dependency),
    `${JSON.stringify({ packageName: dependency.packageName, sourceDir, revision }, null, 2)}\n`,
  );
  process.stdout.write(
    `source dependency ready: ${dependency.packageName} -> ${sourceDir} @ ${revision.slice(0, 12)}\n`,
  );
}

async function materializePackage(dependency, sourceDir, manifest) {
  const targetDir = targetDirectory(dependency);
  await rm(targetDir, { force: true, recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const entry of manifest.files ?? ["dist"]) {
    const sourcePath = path.join(sourceDir, entry);
    try {
      await access(sourcePath);
    } catch {
      fail(`${dependency.packageName} source build did not create package file ${sourcePath}`);
    }
    await cp(sourcePath, path.join(targetDir, entry), { force: true, recursive: true });
  }
}

async function restore() {
  for (const dependency of dependencies) {
    await rm(targetDirectory(dependency), { force: true, recursive: true });
    await rm(stateFile(dependency), { force: true });
  }
  run("bun", ["install", "--frozen-lockfile", "--force"], rootDir);
  process.stdout.write("registry editor-family dependencies restored\n");
}

async function status() {
  for (const dependency of dependencies) {
    const state = await readState(dependency);
    if (!state) {
      process.stdout.write(`registry dependency active: ${dependency.packageName}\n`);
      continue;
    }
    process.stdout.write(
      `source dependency active: ${dependency.packageName} -> ${state.sourceDir} @ ${state.revision.slice(0, 12)}\n`,
    );
  }
}

async function smoke() {
  for (const dependency of dependencies) {
    const state = await readState(dependency);
    if (!state) fail(`source mode is not active for ${dependency.packageName}`);
    const manifest = JSON.parse(
      await readFile(path.join(targetDirectory(dependency), "package.json"), "utf8"),
    );
    if (manifest.name !== dependency.packageName) {
      fail(`source package has name ${manifest.name ?? "unknown"}, expected ${dependency.packageName}`);
    }
    await import(dependency.packageName);
    process.stdout.write(
      `source dependency smoke passed: ${dependency.packageName} @ ${state.revision.slice(0, 12)}\n`,
    );
  }
}

async function readState(dependency) {
  try {
    const state = JSON.parse(await readFile(stateFile(dependency), "utf8"));
    await access(path.join(targetDirectory(dependency), "package.json"));
    return state;
  } catch {
    return undefined;
  }
}

async function readSourceManifest(dependency, sourceDir) {
  try {
    await access(path.join(sourceDir, "package.json"));
  } catch {
    fail(
      `missing ${dependency.packageName} source checkout at ${sourceDir}; set ${dependency.sourceEnv} to override`,
    );
  }
  const manifest = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
  if (!dependency.acceptedSourceNames.includes(manifest.name)) {
    fail(
      `expected ${dependency.acceptedSourceNames.join(" or ")} at ${sourceDir}, found ${manifest.name ?? "unnamed package"}`,
    );
  }
  return manifest;
}

function resolveSourceDir(dependency) {
  return path.resolve(process.env[dependency.sourceEnv] ?? dependency.defaultSourceDir);
}

function targetDirectory(dependency) {
  return path.join(rootDir, "node_modules", ...dependency.packageName.split("/"));
}

function stateFile(dependency) {
  return path.join(stateDir, `${dependency.packageName.replaceAll("/", "__")}.json`);
}

function run(executable, args, cwd, capture = false) {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0) fail(`${executable} ${args.join(" ")} failed in ${cwd}`);
  return capture ? result.stdout : "";
}

function fail(message) {
  process.stderr.write(`source dependency error: ${message}\n`);
  process.exit(1);
}
