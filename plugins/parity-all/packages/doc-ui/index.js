/**
 * dsh-doc-project-ui — Host half.
 *
 * One operation (`listProjectDocuments`) serves the Documents page through the
 * package-private /bionic-docs/api/list route. It walks each registered
 * workspace's directory (depth 2) for document deliverables and returns names,
 * sizes, and modification times sorted newest first.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const inject = ["workspaceRegistry", "fs"];

const DOC_EXTENSIONS = new Set([
	"md", "markdown", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "csv", "pdf", "txt",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".dsh", ".cache", "dist", "build", "__pycache__", ".venv"]);
const MAX_DOCS_PER_WORKSPACE = 40;

function listProjectDocuments(ctx) {
	const workspaces = [];
	for (const ws of ctx.workspaceRegistry.list()) {
		const path = typeof ws.path === "string" ? ws.path : typeof ws.directory === "string" ? ws.directory : undefined;
		if (path === undefined) continue;
		const docs = [];
		try {
			scan(path, path, 0, docs);
		} catch (error) {
			docs.push({ name: "(scan failed)", rel: "", bytes: 0, mtime: Date.now(), error: String(error?.message ?? error) });
		}
		docs.sort((a, b) => b.mtime - a.mtime);
		workspaces.push({
			id: ws.id,
			title: ws.title ?? ws.name ?? path.split("/").pop() ?? path,
			path,
			docCount: docs.length,
			docs: docs.slice(0, MAX_DOCS_PER_WORKSPACE),
		});
	}
	return workspaces;
}

function scan(root, dir, depth, docs) {
	if (depth > 2 || docs.length >= MAX_DOCS_PER_WORKSPACE) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (docs.length >= MAX_DOCS_PER_WORKSPACE) return;
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			scan(root, full, depth + 1, docs);
			continue;
		}
		if (!entry.isFile()) continue;
		const dot = entry.name.lastIndexOf(".");
		const ext = dot < 0 ? "" : entry.name.slice(dot + 1).toLowerCase();
		if (!DOC_EXTENSIONS.has(ext)) continue;
		let size = 0;
		let mtime = 0;
		try {
			const st = statSync(full);
			size = st.size;
			mtime = st.mtimeMs;
		} catch {}
		docs.push({ name: entry.name, ext, rel: relative(root, full), bytes: size, mtime });
	}
}

export function apply(ctx) {
	const web = ctx.get("webServer");
	if (web === undefined) return;
	const sendJson = (res, status, body) => {
		const payload = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(payload);
	};
	ctx.effect(
		() =>
			web.register({
				kind: "exact",
				path: "/bionic-docs/api/list",
				handler: async (req, res) => {
					if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
					try {
						return sendJson(res, 200, { ok: true, generatedAt: Date.now(), workspaces: listProjectDocuments(ctx) });
					} catch (error) {
						return sendJson(res, 200, { ok: false, error: String(error?.message ?? error), workspaces: [] });
					}
				},
			}),
		"bionic-docs list route",
	);
}
