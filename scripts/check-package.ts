import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command: string, args: string[], options: { cwd: string }): string {
  return execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" });
}

function fail(message: string): never {
  console.error(`check-package: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

interface NpmPackEntry {
  filename: string;
}

function main(): void {
  const repoRoot = process.cwd();
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
    bin?: Record<string, string>;
  };
  assert(pkg.name === "@nocoo/ag", `package.json name must be "@nocoo/ag", got ${pkg.name}`);
  const binPath = pkg.bin?.["ag-cli"];
  assert(
    binPath === "dist/index.js" || binPath === "./dist/index.js",
    `package.json bin["ag-cli"] must be "dist/index.js" or "./dist/index.js", got ${binPath}`,
  );

  console.log("check-package: running bun run build");
  execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  const binaryPath = join(repoRoot, "dist", "ag-cli");
  assert(existsSync(binaryPath), "dist/ag-cli missing: the compiled binary was not built");
  execFileSync(binaryPath, ["--help"], { cwd: repoRoot, stdio: "inherit" });
  execFileSync(binaryPath, ["--skill"], { cwd: repoRoot, stdio: "inherit" });
  console.log("check-package: compiled binary --help and --skill verified");

  const packDir = mkdtempSync(join(tmpdir(), "ag-cli-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "ag-cli-install-"));
  try {
    const packOutput = run("npm", ["pack", "--pack-destination", packDir, "--json"], {
      cwd: repoRoot,
    });
    const entries = JSON.parse(packOutput) as NpmPackEntry[];
    const packed = entries[0];
    assert(packed !== undefined, `npm pack returned ${entries.length} entries`);
    const tarballPath = join(packDir, packed.filename);
    assert(existsSync(tarballPath), `tarball missing: ${tarballPath}`);
    console.log(`check-package: packed ${packed.filename}`);

    const entryPath = existsSync(join(repoRoot, "dist/index.js")) ? "package/dist/index.js" : null;
    if (entryPath) {
      const listing = run("tar", ["-tzf", tarballPath], { cwd: repoRoot });
      assert(
        listing.split("\n").some((line) => line === entryPath),
        `tarball does not contain ${entryPath}`,
      );

      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
        cwd: installDir,
      });
      const installedEntry = join(installDir, "node_modules/@nocoo/ag/dist/index.js");
      assert(existsSync(installedEntry), `installed entry missing: ${installedEntry}`);
      assert(
        existsSync(join(installDir, "node_modules/.bin/ag-cli")),
        "node_modules/.bin/ag-cli link missing after install",
      );

      const firstLine = readFileSync(installedEntry, "utf8").split("\n")[0] ?? "";
      assert(firstLine.startsWith("#!"), `installed dist/index.js lacks shebang: ${firstLine}`);

      execFileSync(join(installDir, "node_modules/.bin/ag-cli"), ["--help"], {
        cwd: installDir,
        stdio: "inherit",
      });
      execFileSync(join(installDir, "node_modules/.bin/ag-cli"), ["--skill"], {
        cwd: installDir,
        stdio: "inherit",
      });
      console.log("check-package: installed bin shebang, --help and --skill verified");
    } else {
      console.log("check-package: dist/index.js not produced yet, skipping bin checks");
    }
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
}

main();
