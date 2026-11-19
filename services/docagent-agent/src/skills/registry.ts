/** 版本化 skill 注册表：启动扫描安装，任务创建时固定 skill_ref。 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Db, SkillRow } from "../db.js";
import { installSkill, loadSkillBody, listPackageFiles, readPackageText, resolveInPackage } from "./loader.js";
import type { SkillPackage } from "./loader.js";

export class SkillRegistry {
  constructor(
    private readonly db: Db,
    private readonly skillsRoot: string = config.skillsDir,
  ) {}

  /** 扫描 skills 根目录下的目录与 ZIP，安装未登记的包。 */
  scanRoot(): SkillPackage[] {
    const root = this.skillsRoot;
    fs.mkdirSync(root, { recursive: true });
    const installed: SkillPackage[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const full = path.join(root, entry.name);
      try {
        installed.push(this.install(full));
      } catch (error) {
        // 单个包损坏不阻塞其余
        console.warn(`[skills] 安装失败 ${entry.name}:`, error instanceof Error ? error.message : error);
      }
    }
    return installed;
  }

  install(source: string): SkillPackage {
    const pkg = installSkill(source, this.skillsRoot);
    this.db.upsertSkill({
      ref: pkg.ref,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      root_path: pkg.rootPath,
      manifest: JSON.stringify(pkg.manifest),
    });
    return pkg;
  }

  get(ref: string): SkillRow | undefined {
    // 允许仅用 name 引用：取该 name 最新安装的版本
    if (!ref.includes("@")) {
      return this.db
        .getSkill(ref) ??
        (this.db.listSkills().find((s) => s.name === ref));
    }
    return this.db.getSkill(ref);
  }

  /** 未指定 skill 时的缺省：清单第一个（M1 单 skill 场景）。 */
  defaultSkill(): SkillRow | undefined {
    return this.db.listSkills()[0];
  }

  /** 技能清单（系统提示里的 skill 列表，预算约 12k 字符）。 */
  manifestListing(): string {
    const skills = this.db.listSkills();
    const lines: string[] = ["可用 skill（通过 skill 工具按 name 加载）："];
    let budget = config.skillManifestBudgetChars;
    for (const s of skills) {
      const manifest = JSON.parse(s.manifest) as { name: string; description: string; version: string };
      const line = `- ${manifest.name}（v${manifest.version}）：${manifest.description || "（无描述）"}`;
      if (line.length > budget) break;
      lines.push(line);
      budget -= line.length;
    }
    return lines.length > 1 ? lines.join("\n") : "（未安装任何 skill）";
  }

  bodyFor(ref: string): ReturnType<typeof loadSkillBody> {
    const row = this.get(ref);
    if (!row) throw new Error(`skill 未安装：${ref}`);
    return loadSkillBody({
      ref: row.ref,
      manifest: JSON.parse(row.manifest),
      rootPath: row.root_path,
      skillMdPath: path.join(row.root_path, "SKILL.md"),
    });
  }

  filesFor(ref: string, dir: string): string[] {
    const row = this.get(ref);
    if (!row) throw new Error(`skill 未安装：${ref}`);
    return listPackageFiles(row.root_path, dir);
  }

  textFor(ref: string, relative: string, opts: { offset?: number; limit?: number }) {
    const row = this.get(ref);
    if (!row) throw new Error(`skill 未安装：${ref}`);
    return readPackageText(row.root_path, relative, opts);
  }

  rootFor(ref: string): string {
    const row = this.get(ref);
    if (!row) throw new Error(`skill 未安装：${ref}`);
    return row.root_path;
  }

  /** 供 write 工具校验：路径不得落进 skill 根（包只读）。 */
  isSkillPath(target: string): boolean {
    const root = path.resolve(config.skillsDir);
    return path.resolve(target).startsWith(root + path.sep) || path.resolve(target) === root;
  }
}

export { resolveInPackage };
