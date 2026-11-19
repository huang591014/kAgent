import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { installSkill, listPackageFiles, loadSkillBody, parseFrontmatter, readPackageText, resolveInPackage } from "../src/skills/loader.js";

const tempDirs: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SKILL_MD = `---
name: demo-skill
description: 测试用技能
---

# 演示技能

正文内容。资源根：\${SKILL_DIR}
`;

describe("parseFrontmatter", () => {
  it("解析 name/description", () => {
    const { data, body } = parseFrontmatter(SKILL_MD);
    expect(data.name).toBe("demo-skill");
    expect(data.description).toBe("测试用技能");
    expect(body).toContain("演示技能");
  });
});

describe("installSkill（目录与 ZIP）", () => {
  it("从目录安装并做版本化（内容摘要）", () => {
    const root = makeTemp();
    const skillsRoot = makeTemp();
    const pkgDir = path.join(root, "demo-skill");
    mkdirSync(path.join(pkgDir, "references"), { recursive: true });
    writeFileSync(path.join(pkgDir, "SKILL.md"), SKILL_MD);
    writeFileSync(path.join(pkgDir, "references", "rules.md"), "# 规则\n第一条…");

    const pkg = installSkill(pkgDir, skillsRoot);
    expect(pkg.manifest.name).toBe("demo-skill");
    expect(pkg.ref).toMatch(/^demo-skill@[0-9a-f]{12}$/);
    expect(listPackageFiles(pkg.rootPath, "references")).toEqual(["rules.md"]);

    const read = readPackageText(pkg.rootPath, "references/rules.md");
    expect(read.text).toContain("第一条");

    const body = loadSkillBody(pkg);
    expect(body.content).toContain("演示技能");
    expect(body.content).toContain(pkg.rootPath); // ${SKILL_DIR} 展开为资源根
  });

  it("从 ZIP 安装（自动剥掉顶层目录）", () => {
    const root = makeTemp();
    const skillsRoot = makeTemp();
    const zip = new AdmZip();
    zip.addFile("demo-skill/SKILL.md", Buffer.from(SKILL_MD, "utf8"));
    zip.addFile("demo-skill/references/common.md", Buffer.from("# 共性\n", "utf8"));
    const zipPath = path.join(root, "demo.zip");
    zip.writeZip(zipPath);

    const pkg = installSkill(zipPath, skillsRoot);
    expect(pkg.manifest.name).toBe("demo-skill");
    expect(listPackageFiles(pkg.rootPath, "references")).toEqual(["common.md"]);
  });

  it("缺少 SKILL.md 报错", () => {
    const root = makeTemp();
    const skillsRoot = makeTemp();
    mkdirSync(path.join(root, "empty"), { recursive: true });
    expect(() => installSkill(path.join(root, "empty"), skillsRoot)).toThrow("SKILL.md");
  });
});

describe("resolveInPackage 路径约束", () => {
  it("拒绝越界与绝对路径", () => {
    const root = makeTemp();
    expect(() => resolveInPackage(root, "../outside.txt")).toThrow("越界");
    expect(() => resolveInPackage(root, "/etc/passwd")).toThrow("相对路径");
    expect(() => resolveInPackage(root, "C:/windows")).toThrow("相对路径");
    expect(resolveInPackage(root, "references/a.md")).toBe(path.resolve(root, "references/a.md"));
  });
});
