/**
 * dsh-skill-install — Bionic-style skill installation.
 *
 * Tool `install_skill(url)` fetches a SKILL.md (direct raw URL or GitHub blob URL,
 * also directory URLs ending in `/`), validates its frontmatter, and writes it to
 * the configured installDir/<name>/SKILL.md inside the profile's skill root, where
 * the watching skill-filesystem provider picks it up automatically.
 * `remove_skill(name)` deletes an installed skill from installDir only.
 */
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const inject = ["tools", "skills"];

const MAX_SKILL_BYTES = 512 * 1024;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function resolveConfig(raw) {
	const source = raw && typeof raw === "object" ? raw : {};
	const configured = typeof source.installDir === "string" && source.installDir.length > 0 ? source.installDir : join(homedir(), ".dsh", "skills");
	const installDir = resolve(configured);
	if (!isAbsolute(installDir)) throw new Error(`dsh-skill-install: installDir must be absolute, got ${configured}`);
	return { installDir };
}

function parseFrontmatter(text) {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return null;
	const block = text.slice(text.indexOf("\n") + 1, end);
	const out = {};
	for (const line of block.split(/\r?\n/)) {
		const m = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line);
		if (!m) continue;
		out[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

function toRawUrl(url) {
	const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url);
	if (github) return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}/${github[4]}`;
	if (url.endsWith("/")) return `${url}SKILL.md`;
	return url;
}

function nameFromUrl(url) {
	const file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
	const base = (file === "SKILL.md" ? decodeURIComponent(new URL(url).pathname.split("/").at(-2) ?? "") : file.replace(/\.mdx?$/i, "")) || "imported-skill";
	return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "imported-skill";
}

export function apply(ctx, raw) {
	const { installDir } = resolveConfig(raw);

	async function fetchSkillText(url) {
		const target = toRawUrl(url);
		const response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(30000) });
		if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${target}`);
		const text = await response.text();
		if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
		if (!/^\s*---/.test(text)) throw new Error(`${target} does not look like a SKILL.md (no frontmatter); refusing to install`);
		return { text, target };
	}

	const dispose = ctx.tools.register({
		name: "install_skill",
		description:
			"Install an Agent-Skills SKILL.md from a URL (raw file URL, GitHub blob URL, or a directory URL ending in '/') into the profile skill root. Validates frontmatter (name, description). Set overwrite:true to replace an existing skill with the same name. Returns the installed path; the skill becomes available in the catalog on the next lookup.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "SKILL.md URL, GitHub blob URL, or skill directory URL ending in '/'." },
				overwrite: { type: "boolean", description: "Replace an existing skill with the same name. Default false." },
			},
			required: ["url"],
			additionalProperties: false,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
		},
		timeoutMs: 60000,
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const { text, target } = await fetchSkillText(String(args.url));
			const frontmatter = parseFrontmatter(text);
			const name = frontmatter?.name ?? nameFromUrl(target);
			if (!NAME_RE.test(name)) return { ok: false, error: `skill name ${JSON.stringify(name)} is invalid (lowercase letters, digits, hyphens)` };
			const dir = join(installDir, name);
			if (resolve(dir) !== resolve(installDir, name)) return { ok: false, error: "resolved path escaped the install directory" };
			const file = join(dir, "SKILL.md");
			const exists = await access(file).then(() => true, () => false);
			if (exists && args.overwrite !== true) return { ok: false, error: `skill ${JSON.stringify(name)} already exists at ${file}; pass overwrite:true to replace` };
			await mkdir(dir, { recursive: true });
			await writeFile(file, text, "utf8");
			let catalogCheck = null;
			try {
				const summaries = await ctx.skills.list();
				catalogCheck = summaries.some((skill) => skill.name === name);
			} catch {
				catalogCheck = "unknown";
			}
			return {
				ok: true,
				name,
				description: frontmatter?.description ?? null,
				path: file,
				replaced: exists,
				inSkillCatalog: catalogCheck,
				note: exists ? "Replaced the previous copy." : "Installed as a new skill.",
			};
		},
	});
	ctx.effect(() => dispose);

	const disposeRemove = ctx.tools.register({
		name: "remove_skill",
		description: "Remove a skill previously installed by install_skill (only inside the profile install directory). Provide the skill name.",
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "Installed skill name (directory name under the install root)." } },
			required: ["name"],
			additionalProperties: false,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
		},
		timeoutMs: 15000,
		async execute(args) {
			const name = String(args.name);
			if (!NAME_RE.test(name)) return { ok: false, error: `invalid skill name ${JSON.stringify(name)}` };
			const dir = resolve(installDir, name);
			if (!dir.startsWith(resolve(installDir) + "/")) return { ok: false, error: "refusing to touch paths outside the install directory" };
			const exists = await access(join(dir, "SKILL.md")).then(() => true, () => false);
			if (!exists) return { ok: false, error: `no installed skill ${JSON.stringify(name)} at ${dir}/SKILL.md` };
			await rm(dir, { recursive: true });
			return { ok: true, removed: dir };
		},
	});
	ctx.effect(() => disposeRemove);
}
