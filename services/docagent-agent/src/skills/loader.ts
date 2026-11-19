/** skill 包加载：接受目录或 ZIP，版本化安装，路径约束在资源根内（设计 §4.3）。

参考 ZCode 的 skill 资源根实现：SKILL.md 正文按需加载、字节上限、
base directory 注入；这里额外做版本化安装（内容摘要做版本号）。
*/

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { config } from "../config.js";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
}

export interface SkillPackage {
  ref: string; // name@version
  manifest: SkillManifest;
  rootPath: string; // 该版本资源根（只读）
  skillMdPath: string;
}

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const header = raw.slice(3, end).replace(/^\r?\n/, "");
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) data[key] = value;
  }
  return { data, body };
}


/** 安装 skill 包：源可以是目录或 ZIP；安装到 skillsDir/<name>/<version>/。
 *
 * - 每次安装使用独立随机暂存目录，异常包只影响本次暂存；
 * - 版本号缺省时取**全包内容摘要**（入口文件、规则卡、模板、资产都参与），
 *   任意资源变化都会产生新版本；同内容重复安装幂等返回原引用；
 * - 显式版本号已发布时不可覆盖（内容不同需升版本号另行发布）。
 */
export function installSkill(source: string, skillsRoot: string = config.skillsDir): SkillPackage {
  const stat = fs.statSync(source);
  fs.mkdirSync(skillsRoot, { recursive: true });
  const installRoot = fs.mkdtempSync(path.join(skillsRoot, "_install-"));
  try {
    return installFromStaging(stat, source, installRoot, skillsRoot);
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
}

function installFromStaging(
  stat: { isDirectory(): boolean },
  source: string,
  installRoot: string,
  skillsRoot: string,
): SkillPackage {
  let staging: string;
  if (stat.isDirectory()) {
    staging = copyTree(source, installRoot);
  } else if (source.toLowerCase().endsWith(".zip")) {
    staging = extractZip(source, installRoot);
  } else {
    throw new Error(`skill 源必须是目录或 ZIP：${source}`);
  }

  const skillMd = findSkillMd(staging);
  if (!skillMd) throw new Error("skill 包缺少 SKILL.md");
  const packageDir = path.dirname(skillMd);
  const raw = fs.readFileSync(skillMd, "utf8");
  const { data } = parseFrontmatter(raw);
  const name = data.name || path.basename(packageDir);
  if (!/^[\w.-]+$/.test(name)) throw new Error(`skill 名称不合法：${name}`);
  const explicitVersion = data.version && data.version.trim() ? data.version.trim() : null;
  const version = explicitVersion ?? packageDigest(packageDir);
  const description = (data.description || "").slice(0, 2000);

  const finalRoot = path.join(skillsRoot, name, version);
  if (fs.existsSync(finalRoot)) {
    if (explicitVersion) {
      throw new Error(
        `skill 版本已发布，不可覆盖：${name}@${version}。内容变化请升版本号后另行发布。`,
      );
    }
    // 摘要版本：同内容重复安装，幂等返回已安装的包
    return {
      ref: `${name}@${version}`,
      manifest: { name, description, version },
      rootPath: finalRoot,
      skillMdPath: path.join(finalRoot, "SKILL.md"),
    };
  }

  fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
  fs.renameSync(packageDir, finalRoot);

  return {
    ref: `${name}@${version}`,
    manifest: { name, description, version },
    rootPath: finalRoot,
    skillMdPath: path.join(finalRoot, "SKILL.md"),
  };
}

/** 全包内容摘要：按相对路径排序，对每个文件内容做链式 hash（入口、规则卡、模板、资产全覆盖）。 */
function packageDigest(packageDir: string): string {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]) {
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(packageDir, "");
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(packageDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function copyTree(src: string, destRoot: string): string {
  const target = path.join(destRoot, path.basename(src));
  fs.cpSync(src, target, { recursive: true });
  return target;
}

function extractZip(zipPath: string, destRoot: string): string {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.entryName === "__MACOSX/" || entry.entryName.startsWith("__MACOSX/")) continue;
    if (entry.isDirectory) continue;
    if (entry.header.size > MAX_ENTRY_BYTES) throw new Error(`skill 包内文件过大：${entry.entryName}`);
    const target = path.join(destRoot, entry.entryName);
    if (!path.resolve(target).startsWith(path.resolve(destRoot))) {
      throw new Error(`skill 包内路径越界：${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
  // 若根下只有一个目录，取该目录为包根
  const entries = fs.readdirSync(destRoot);
  if (entries.length === 1) {
    const only = path.join(destRoot, entries[0]!);
    if (fs.statSync(only).isDirectory()) return only;
  }
  return destRoot;
}

function findSkillMd(root: string): string | null {
  const direct = path.join(root, "SKILL.md");
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]) {
    const candidate = path.join(root, entry);
    if (entry.endsWith("SKILL.md") && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 解析包内相对路径；拒绝越界与绝对路径。 */
export function resolveInPackage(rootPath: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`只允许包内相对路径：${relative}`);
  }
  const resolved = path.resolve(rootPath, normalized);
  if (resolved !== path.resolve(rootPath) && !resolved.startsWith(path.resolve(rootPath) + path.sep)) {
    throw new Error(`路径越界：${relative}`);
  }
  return resolved;
}

/** 列举包内资源文件（相对路径，限定常见文本与资源目录）。 */
export function listPackageFiles(rootPath: string, relativeDir = "."): string[] {
  const dir = resolveInPackage(rootPath, relativeDir);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: false }) as fs.Dirent[]) {
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    out.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }
  return out.sort();
}

export interface LoadedSkillBody {
  content: string;
  truncated: boolean;
  baseDirectory: string;
}

/** 读取 SKILL.md 正文（初始上限 100KB，超出截尾并标记）。 */
export function loadSkillBody(pkg: SkillPackage, maxBytes = config.skillBodyMaxBytes): LoadedSkillBody {
  const raw = fs.readFileSync(pkg.skillMdPath, "utf8");
  const { body } = parseFrontmatter(raw);
  const expanded = body.replaceAll("${SKILL_DIR}", pkg.rootPath).replaceAll(
    /\$\{(CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/g,
    pkg.rootPath,
  );
  const bytes = Buffer.byteLength(expanded, "utf8");
  if (bytes <= maxBytes) return { content: expanded, truncated: false, baseDirectory: pkg.rootPath };
  // 按字符安全截断到字节上限以内
  let text = expanded;
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = text.slice(0, Math.floor(text.length * 0.9));
  }
  return { content: `${text}\n\n[skill 正文超长，已截断]`, truncated: true, baseDirectory: pkg.rootPath };
}

/** 读取包内文本资源（分页）。 */
export function readPackageText(
  rootPath: string,
  relative: string,
  opts: { offset?: number; limit?: number } = {},
): { text: string; offset: number; total: number; truncated: boolean } {
  const target = resolveInPackage(rootPath, relative);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`不是文件：${relative}`);
  if (stat.size > MAX_ENTRY_BYTES) throw new Error(`文件过大：${relative}`);
  const raw = fs.readFileSync(target, "utf8");
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 20_000), 100_000);
  const total = raw.length;
  const text = raw.slice(offset, offset + limit);
  return { text, offset, total, truncated: offset + text.length < total };
}
