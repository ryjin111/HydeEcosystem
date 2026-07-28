// Reproducible Foundry dependency bootstrap. The large libraries stay ignored so the application repo
// does not vendor them, but every fresh checkout installs the exact revisions used by the audited builds.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencies = [
  {
    marker: resolve(repositoryRoot, "contracts/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol"),
    target: resolve(repositoryRoot, "contracts/lib/openzeppelin-contracts"),
    url: "https://github.com/OpenZeppelin/openzeppelin-contracts.git",
    revision: "69c8def5f222ff96f2b5beff05dfba996368aa79",
  },
  {
    marker: resolve(repositoryRoot, "contracts/lib/v4-periphery/src/PositionManager.sol"),
    target: resolve(repositoryRoot, "contracts/lib/v4-periphery"),
    url: "https://github.com/Uniswap/v4-periphery.git",
    revision: "3245c3cb99c48fa1dc2459c3b60abc37d4294aba",
  },
];

function runGit(args, cwd = repositoryRoot) {
  const result = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function currentRevision(dependency) {
  if (!existsSync(dependency.marker)) return null;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dependency.target,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim().toLowerCase() : null;
}

const pending = dependencies.filter(
  (dependency) => currentRevision(dependency) !== dependency.revision.toLowerCase(),
);
if (pending.length === 0) {
  console.log("Foundry dependencies already installed at the pinned revisions.");
  process.exit(0);
}

for (const dependency of pending) {
  if (!existsSync(dependency.target)) {
    runGit(["clone", "--no-checkout", dependency.url, dependency.target]);
  } else if (currentRevision(dependency) === null) {
    throw new Error(`Dependency directory is not a Git checkout: ${dependency.target}`);
  }
  runGit(["checkout", "--detach", dependency.revision], dependency.target);
  runGit(["submodule", "update", "--init", "--recursive"], dependency.target);
}

const unresolved = dependencies.filter(
  (dependency) => currentRevision(dependency) !== dependency.revision.toLowerCase(),
);
if (unresolved.length > 0) {
  throw new Error(`Foundry dependency install incomplete: ${unresolved.map((item) => item.url).join(", ")}`);
}
console.log("Pinned Foundry dependencies installed.");
