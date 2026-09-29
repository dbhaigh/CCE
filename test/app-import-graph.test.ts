import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

test("preferences and simulation store have no runtime import cycle", () => {
  const directory = join(process.cwd(), "src", "app");
  const files = readdirSync(directory).filter((name) => /\.tsx?$/.test(name));
  const modules = new Set(files.map((name) => name.replace(/\.tsx?$/, "")));
  const dependencies = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(join(directory, file), "utf8"),
      ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith("./")) continue;
      const dependency = specifier.slice(2).replace(/\.js$/, "");
      if (modules.has(dependency)) imports.push(dependency);
    }
    dependencies.set(file.replace(/\.tsx?$/, ""), imports);
  }

  function reaches(start: string, target: string, visited = new Set<string>()): boolean {
    if (visited.has(start)) return false;
    visited.add(start);
    return (dependencies.get(start) ?? []).some((next) =>
      next === target || reaches(next, target, visited));
  }
  assert.equal(reaches("preferences", "simulation-store"), false);
  assert.equal(reaches("simulation-store", "preferences"), true);
});
