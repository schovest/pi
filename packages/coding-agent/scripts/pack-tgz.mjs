import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";

const pkg = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
);

const distDir = resolve(import.meta.dirname, "..", "dist");
const binaryPath = join(distDir, "pi");

if (!existsSync(binaryPath)) {
	console.error("Binary not found at", binaryPath);
	console.error("Run 'npm run build:binary' first");
	process.exit(1);
}

const archMap = { x64: "x86_64", arm64: "aarch64" };
const platformMap = { linux: "linux", darwin: "macos", win32: "windows" };

const arch = archMap[osArch()] || osArch();
const platform = platformMap[osPlatform()] || osPlatform();
const version = pkg.version || "0.0.0";

const archiveName = `pi-${version}-${platform}-${arch}.tgz`;
const archivePath = join(distDir, archiveName);

const fileList = [
	"pi",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"theme",
	"assets",
	"export-html",
	"extensions",
	"primary-agents",
	"docs",
	"examples",
	"photon_rs_bg.wasm",
	"install.sh",
];

// Pack into a versioned subdirectory so extraction yields pi-x.x.x/install.sh
const stagingDir = join(distDir, `pi-${version}`);
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
for (const file of fileList) {
	const src = join(distDir, file);
	if (existsSync(src)) {
		cpSync(src, join(stagingDir, file), { recursive: true });
	}
}

console.log(`Packing into ${archiveName}...`);
execSync(`tar -czf '${archivePath}' -C '${distDir}' 'pi-${version}'`, { stdio: "inherit" });

// Cleanup staging
rmSync(stagingDir, { recursive: true, force: true });

console.log(`Created: ${archivePath}`);
