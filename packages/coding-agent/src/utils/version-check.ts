import { getPiUserAgent } from "./pi-user-agent.ts";

/**
 * 上游仓库 —— 所有版本检测和 self-update 都指向这个 GitHub 仓库。
 */
const GITHUB_REPO = "schovest/pi";

/**
 * 获取最新 release 的 tag 名称（形如 "vX.Y.Z"）。
 *
 * 首选方案：GitHub 网页重定向（https://github.com/<repo>/releases/latest →
 *   /releases/tag/vX.Y.Z），只请求 github.com 网页前端，完全不走 API，
 *   不受匿名用户 60 次/小时的速率限制。使用 fetch redirect:"follow" 后从
 *   response.url 中提取 tag。
 * 回退方案：GitHub API releases/latest（受速率限制，仅在首选方案失败时使用）。
 */
const RELEASES_LATEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const API_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * 通过 GitHub 网页重定向获取最新 release tag（无速率限制）。
 *
 * fetch 默认跟随重定向，response.url 即最终落地 URL
 * （https://github.com/schovest/pi/releases/tag/vX.Y.Z）。
 * 使用 method:HEAD 避免下载完整页面 body。
 */
async function getLatestTagViaRedirect(currentVersion: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const response = await fetch(RELEASES_LATEST_URL, {
			method: "HEAD",
			headers: { "User-Agent": getPiUserAgent(currentVersion) },
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		// 从 .../releases/tag/vX.Y.Z 中提取 tag
		const match = response.url.match(/\/releases\/tag\/(.+)$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * 通过 GitHub API 获取最新 release tag（匿名限速 60 次/小时，仅作回退）。
 */
async function getLatestTagViaApi(currentVersion: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const response = await fetch(API_LATEST_URL, {
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { tag_name?: unknown };
		if (typeof data.tag_name === "string" && data.tag_name.trim()) {
			return data.tag_name.trim();
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;

	// 首选：网页重定向（无速率限制）
	let tag = await getLatestTagViaRedirect(currentVersion, timeoutMs);

	// 回退：GitHub API（匿名限速 60 次/小时）
	if (!tag) {
		tag = await getLatestTagViaApi(currentVersion, timeoutMs);
	}

	if (!tag) return undefined;

	// 去掉 'v' 前缀
	const version = tag.replace(/^v/, "");
	if (!version.trim()) return undefined;

	return { version: version.trim() };
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
