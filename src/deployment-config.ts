import * as fs from "fs";
import * as path from "path";
import { diagnosticFingerprint } from "./baseline";
import {
  Diagnostic,
  DiagnosticSeverity,
  VerificationResult,
} from "./types/verifier";

const RANK: Record<DiagnosticSeverity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};
interface Options {
  projectRoot: string;
  baselineFingerprints?: ReadonlySet<string>;
  failOn?: DiagnosticSeverity;
  disabledRules?: string[];
  severityOverrides?: Record<string, DiagnosticSeverity>;
}

export function verifyDeploymentConfigs(
  targets: string[],
  options: Options,
): VerificationResult[] {
  return discover(targets).map((file) => verify(file, options));
}

function discover(targets: string[]): string[] {
  const found = new Set<string>();
  const skipped = new Set([
    "node_modules",
    "dist",
    "build",
    ".git",
    "coverage",
    "Pods",
    "DerivedData",
  ]);
  const walk = (entry: string): void => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isFile()) {
      const base = path.basename(entry);
      const workflow =
        /\.ya?ml$/.test(base) &&
        entry.includes(`${path.sep}.github${path.sep}workflows${path.sep}`);
      const infrastructure =
        /\.tf$/.test(base) ||
        (/(?:^|[-_.])(?:deployment|statefulset|daemonset|pod|job|cronjob|k8s|kubernetes)(?:[-_.]|$)/i.test(
          base,
        ) &&
          /\.ya?ml$/.test(base));
      if (/^Dockerfile(?:\..+)?$/.test(base) || workflow || infrastructure)
        found.add(path.resolve(entry));
      return;
    }
    for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
      if (child.isDirectory() && skipped.has(child.name)) continue;
      walk(path.join(entry, child.name));
    }
  };
  targets.forEach(walk);
  return [...found].sort();
}

function verify(filePath: string, options: Options): VerificationResult {
  const started = Date.now();
  const code = fs.readFileSync(filePath, "utf8");
  const lines = code.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  const add = (
    ruleId: string,
    severity: DiagnosticSeverity,
    lineIndex: number,
    message: string,
    explanation: string,
    remediation: string,
  ): void => {
    diagnostics.push({
      id: `${filePath}:${lineIndex + 1}:0:${ruleId}`,
      ruleId,
      category: "SECURITY",
      severity,
      message,
      explanation,
      filePath,
      loc: {
        start: { line: lineIndex + 1, column: 0 },
        end: { line: lineIndex + 1, column: lines[lineIndex]?.length ?? 0 },
      },
      codeSnippet: lines[lineIndex] ?? "",
      remediation: { summary: remediation, llmPromptHint: remediation },
    });
  };
  const docker = /^Dockerfile(?:\..+)?$/.test(path.basename(filePath));
  if (docker) {
    let finalUser: { value: string; line: number } | null = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const instruction = line.trim();
      const secret = instruction.match(
        /^(?:ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)/i,
      );
      if (
        secret &&
        /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY/i.test(
          secret[1],
        )
      ) {
        add(
          "SUP-003",
          "HIGH",
          index,
          `Docker build instruction exposes secret-bearing variable '${secret[1]}'.`,
          "ARG and ENV values can persist in image metadata, provenance, or layers.",
          "Use BuildKit secret mounts and keep credentials out of ARG and ENV instructions.",
        );
      }
      const user = instruction.match(/^USER\s+(.+)$/i);
      if (user) finalUser = { value: user[1].trim(), line: index };
    }
    if (!finalUser || /^(?:0|root)(?::|$)/i.test(finalUser.value)) {
      add(
        "SUP-004",
        "MEDIUM",
        finalUser?.line ?? Math.max(0, lines.length - 1),
        finalUser
          ? "Final container user is root."
          : "Dockerfile does not declare a non-root USER.",
        "Processes running as root increase the impact of application or container-runtime compromise.",
        "Create a dedicated unprivileged user and make it the final USER in the runtime stage.",
      );
    }
  } else if (
    filePath.includes(`${path.sep}.github${path.sep}workflows${path.sep}`)
  ) {
    lines.forEach((line, index) => {
      const use = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (use && !use[1].startsWith("./") && !use[1].startsWith("docker://")) {
        const ref = use[1].split("@")[1] ?? "";
        if (!/^[a-f0-9]{40}$/i.test(ref))
          add(
            "SUP-001",
            "MEDIUM",
            index,
            `GitHub Action '${use[1]}' is not pinned to a full commit SHA.`,
            "Tags and branches are mutable and can execute different code without a workflow change.",
            "Pin the action to a reviewed full-length commit SHA and record the release tag in a comment.",
          );
      }
      if (/^\s*permissions:\s*write-all\s*(?:#.*)?$/i.test(line))
        add(
          "SUP-002",
          "HIGH",
          index,
          "GitHub Actions token receives write-all permissions.",
          "A compromised step can modify repository contents and other writable resources.",
          "Declare only the minimum read/write permissions required by each workflow or job.",
        );
    });
  } else if (/\.tf$/.test(filePath)) {
    for (const block of terraformBlocks(code)) {
      if (
        !/\bingress\s*\{/.test(block.text) ||
        !/(?:0\.0\.0\.0\/0|::\/0)/.test(block.text)
      )
        continue;
      const from = Number(block.text.match(/\bfrom_port\s*=\s*(\d+)/)?.[1]);
      const to = Number(block.text.match(/\bto_port\s*=\s*(\d+)/)?.[1]);
      if (
        ![22, 3389].some(
          (port) =>
            Number.isFinite(from) &&
            Number.isFinite(to) &&
            from <= port &&
            to >= port,
        )
      )
        continue;
      add(
        "IAC-003",
        "HIGH",
        block.line,
        "Terraform ingress exposes an administrative port to the public internet.",
        "Public SSH or RDP access materially increases brute-force and remote-compromise exposure.",
        "Restrict administrative ingress to a trusted CIDR, VPN, bastion, or identity-aware access layer.",
      );
    }
  } else {
    if (
      !/^\s*kind:\s*(?:Pod|Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*(?:#.*)?$/im.test(
        code,
      )
    ) {
      return finalize(filePath, lines, diagnostics, started, options);
    }
    lines.forEach((line, index) => {
      if (
        /^\s*(?:privileged|hostNetwork|hostPID|hostIPC):\s*true\s*(?:#.*)?$/i.test(
          line,
        )
      )
        add(
          "IAC-001",
          "CRITICAL",
          index,
          "Kubernetes workload enables privileged execution or a host namespace.",
          "This weakens container isolation and can expose host-level resources to a compromised workload.",
          "Disable privileged mode and host namespace sharing; grant only the specific capability the workload requires.",
        );
      if (
        /^\s*allowPrivilegeEscalation:\s*true\s*(?:#.*)?$/i.test(line) ||
        /^\s*runAs(?:NonRoot|User):\s*(?:false|0)\s*(?:#.*)?$/i.test(line)
      )
        add(
          "IAC-002",
          "HIGH",
          index,
          "Kubernetes workload explicitly permits privilege escalation or root execution.",
          "A compromised process can gain additional privileges or execute with root authority inside the container.",
          "Set allowPrivilegeEscalation=false and runAsNonRoot=true with a non-zero user ID.",
        );
    });
  }
  return finalize(filePath, lines, diagnostics, started, options);
}

function terraformBlocks(code: string): Array<{ text: string; line: number }> {
  const blocks: Array<{ text: string; line: number }> = [];
  const start = /resource\s+"aws_security_group(?:_rule)?"\s+"[^"]+"\s*\{/g;
  for (const match of code.matchAll(start)) {
    let depth = 0;
    let end = match.index!;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      if (code[end] === "}" && --depth === 0) {
        end++;
        break;
      }
    }
    blocks.push({
      text: code.slice(match.index!, end),
      line: code.slice(0, match.index!).split(/\r?\n/).length - 1,
    });
  }
  return blocks;
}

function finalize(
  filePath: string,
  lines: string[],
  diagnostics: Diagnostic[],
  started: number,
  options: Options,
): VerificationResult {
  const disabled = options.disabledRules ?? [];
  const fingerprinted = diagnostics
    .filter(
      (item) =>
        !disabled.some(
          (rule) => item.ruleId === rule || item.ruleId.startsWith(`${rule}-`),
        ),
    )
    .map((item) =>
      options.severityOverrides?.[item.ruleId]
        ? { ...item, severity: options.severityOverrides[item.ruleId] }
        : item,
    )
    .map((item) => ({
      ...item,
      confidence: "HIGH" as const,
      fingerprint: diagnosticFingerprint(item, lines, options.projectRoot),
    }));
  const active = fingerprinted.filter(
    (item) => !options.baselineFingerprints?.has(item.fingerprint),
  );
  const failOn = options.failOn ?? "MEDIUM";
  const blocking = active.filter(
    (item) => RANK[item.severity] >= RANK[failOn],
  ).length;
  const status = blocking ? "FAILED" : "PASSED";
  const count = (severity: DiagnosticSeverity) =>
    active.filter((item) => item.severity === severity).length;
  return {
    filePath,
    status,
    passed: status === "PASSED",
    diagnostics: active,
    checks: [
      {
        id: "deployment-config",
        name: "Supply-chain and deployment configuration",
        status: "PASSED",
        required: true,
      },
    ],
    stats: {
      totalLines: lines.length,
      blocksAnalyzed: 0,
      rulesChecked: 7,
      executionTimeMs: Date.now() - started,
      baselineSuppressed: fingerprinted.length - active.length,
      issuesCount: {
        critical: count("CRITICAL"),
        high: count("HIGH"),
        medium: count("MEDIUM"),
        low: count("LOW"),
        info: count("INFO"),
      },
    },
    summary: blocking
      ? `Verification Failed: Found ${blocking} deployment finding(s) at or above ${failOn}.`
      : `Verification Passed: No deployment findings at or above ${failOn}.`,
  };
}
