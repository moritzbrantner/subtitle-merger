// Materializes the exact-revision JavaScript source checkouts declared in .coding-tooling.source-deps.json
// under their in-repository localPath (.source/<repo>). Source mode itself never fetches; this explicit,
// unauthenticated step makes `bun run source:prepare` and the clean-checkout repository contract work
// from a fresh clone. Existing checkouts must already be at the declared revision; they are never moved.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, ".coding-tooling.source-deps.json"), "utf8"));

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
  return result.stdout.trim();
}

for (const repository of config.javascript?.repositories ?? []) {
  const { git: url, rev, localPath } = repository;
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`${url}: rev must be a full commit SHA`);
  if (!url.startsWith("https://github.com/")) throw new Error(`${url}: only public https://github.com sources are materialized`);
  const target = resolve(root, localPath);
  const inside = relative(resolve(root, ".source"), target);
  if (!inside || inside.startsWith("..") || resolve(root, ".source", inside) !== target) {
    throw new Error(`${localPath}: source checkouts must live under .source/`);
  }
  if (existsSync(target)) {
    const head = git(["-C", target, "rev-parse", "HEAD"]);
    if (head !== rev) throw new Error(`${localPath} is at ${head}, expected ${rev}; move it to the declared revision or remove it.`);
    console.log(`${localPath} already at ${rev}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  git(["init", "-q", target]);
  git(["-C", target, "fetch", "-q", "--depth=1", url, rev]);
  git(["-C", target, "checkout", "-q", "--detach", "FETCH_HEAD"]);
  console.log(`${localPath} materialized at ${rev}`);
}
