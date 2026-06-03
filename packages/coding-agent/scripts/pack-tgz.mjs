import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const archiveName = `pi-${version}-${platform}-${arch}.tar.gz`;
const archivePath = join(distDir, archiveName);

const fdArchMap = { x86_64: "x86_64-unknown-linux-musl", aarch64: "aarch64-unknown-linux-musl" };
const fdArch = fdArchMap[arch];
if (!fdArch || platform !== "linux") {
	console.error(`fd musl binary not available for ${platform}-${arch}`);
	console.error("Skipping fd download. The package will not include fd.");
} else {
	const fdDir = join(distDir, "bin");
	const fdBinary = join(fdDir, "fd");
	if (!existsSync(fdBinary)) {
		console.log("Downloading fd musl binary...");
		const tmpDir = join(distDir, "_fd_tmp");
		execSync(`mkdir -p ${tmpDir}`, { stdio: "inherit" });
		const fdReleaseUrl = `https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-${fdArch}.tar.gz`;
		execSync(`curl -sL ${fdReleaseUrl} | tar -xzf - -C ${tmpDir}`, { stdio: "inherit" });
		const fdSrc = join(tmpDir, `fd-v10.4.2-${fdArch}`, "fd");
		if (!existsSync(fdSrc)) {
			console.error(`fd binary not found in extracted archive at ${fdSrc}`);
			execSync(`rm -rf ${tmpDir}`, { stdio: "inherit" });
			process.exit(1);
		}
		execSync(`mkdir -p ${fdDir} && cp ${fdSrc} ${fdBinary} && chmod +x ${fdBinary}`, { stdio: "inherit" });
		execSync(`rm -rf ${tmpDir}`, { stdio: "inherit" });
		console.log("fd binary ready at", fdBinary);
	} else {
		console.log("fd binary already exists at", fdBinary);
	}
}

if (platform === "linux" && !existsSync(join(distDir, "bin", "fd"))) {
	console.error("Missing required file: dist/bin/fd");
	console.error("Cannot create portable package without fd.");
	process.exit(1);
}

const fileList = [
	"pi",
	"bin",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"theme",
	"assets",
	"export-html",
	"node_modules/@earendil-works/pi-plugins",
	"docs",
	"examples",
	"photon_rs_bg.wasm",
	"install.sh",
];

const args = ["-czf", archivePath, "-C", distDir, ...fileList];

console.log(`Packing into ${archiveName}...`);
execSync(`tar ${args.map((a) => `'${a}'`).join(" ")}`, { stdio: "inherit" });

console.log(`Created: ${archivePath}`);
