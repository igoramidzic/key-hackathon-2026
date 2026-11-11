import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('answer-key guard', () => {
  const srcDir = join(__dirname, '../src');

  function getAllSourceFiles(dir: string): string[] {
    const files: string[] = [];
    if (!existsSync(dir)) return files;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...getAllSourceFiles(fullPath));
      } else if (/\.(ts|js|mjs|cjs)$/.test(entry)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const sourceFiles = getAllSourceFiles(srcDir);

  it('scanned files under src/ exists', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('must not import @sim/scenarios or @sim/contracts/simulator in src/', () => {
    const forbiddenImportRegex =
      /from\s+['"]@sim\/(?:scenarios|contracts\/simulator)(?:\/[^'"]*)?['"]|import\(['"]@sim\/(?:scenarios|contracts\/simulator)(?:\/[^'"]*)?['"]\)|require\(['"]@sim\/(?:scenarios|contracts\/simulator)(?:\/[^'"]*)?['"]\)/;

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const match = forbiddenImportRegex.exec(content);
      expect(
        match,
        `File ${filePath} contains forbidden import to answer key / simulator contracts: "${match?.[0]}"`,
      ).toBeNull();
    }
  });

  it('must not reference port 4000 (simulator) in src/', () => {
    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf-8');
      expect(
        content.includes(':4000'),
        `File ${filePath} contains forbidden reference to simulator port :4000`,
      ).toBe(false);
    }
  });

  it('must not reference /api/scenarios in src/', () => {
    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf-8');
      expect(
        content.includes('/api/scenarios'),
        `File ${filePath} contains forbidden reference to /api/scenarios`,
      ).toBe(false);
    }
  });
});
