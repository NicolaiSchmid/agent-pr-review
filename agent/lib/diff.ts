import { createHash } from "node:crypto";
import type { PullFile } from "./github.js";
import type { Finding } from "./result.js";

export const changedLines = (files: PullFile[]) => {
  const positions = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    let oldLine = 0;
    let newLine = 0;
    for (const row of file.patch.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      } else if (row.startsWith("+") && !row.startsWith("+++")) {
        positions.add(`${file.filename}:RIGHT:${newLine}`);
        newLine += 1;
      } else if (row.startsWith("-") && !row.startsWith("---")) {
        positions.add(`${file.filename}:LEFT:${oldLine}`);
        oldLine += 1;
      } else if (!row.startsWith("\\")) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return positions;
};

export const findingMarker = (headSha: string, finding: Finding) => {
  const identity = [
    headSha,
    finding.path,
    finding.side,
    finding.line,
    finding.title.trim().toLowerCase(),
    finding.body.trim(),
  ].join("\u0000");
  return `<!-- eve-finding:${headSha}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)} -->`;
};

export const validateAndDedupeFindings = (
  headSha: string,
  findings: Finding[],
  files: PullFile[],
  existingBodies: string[] = [],
) => {
  const valid = changedLines(files);
  const seen = new Set<string>();
  const existing = existingBodies.join("\n");
  return findings.filter((finding) => {
    const position = `${finding.path}:${finding.side}:${finding.line}`;
    const marker = findingMarker(headSha, finding);
    if (!valid.has(position) || seen.has(marker) || existing.includes(marker)) return false;
    seen.add(marker);
    return true;
  });
};
