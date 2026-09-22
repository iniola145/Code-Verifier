"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPLOYMENT_RULES = void 0;
// Execution lives in deployment-config.ts because these rules inspect workflow and Docker formats.
exports.DEPLOYMENT_RULES = [
    { id: 'SUP-001', name: 'Unpinned GitHub Action', description: 'Detects non-local actions not pinned to an immutable full commit SHA.', category: 'SECURITY', defaultSeverity: 'MEDIUM', check() { } },
    { id: 'SUP-002', name: 'Overprivileged Workflow Token', description: 'Detects GitHub Actions workflows granting write-all permissions.', category: 'SECURITY', defaultSeverity: 'HIGH', check() { } },
    { id: 'SUP-003', name: 'Docker Build Secret Variable', description: 'Detects secret-bearing ARG or ENV Docker instructions.', category: 'SECURITY', defaultSeverity: 'HIGH', check() { } },
    { id: 'SUP-004', name: 'Container Runs as Root', description: 'Detects Dockerfiles that explicitly use root or omit a final USER.', category: 'SECURITY', defaultSeverity: 'MEDIUM', check() { } },
    { id: 'IAC-001', name: 'Privileged Kubernetes Workload', description: 'Detects privileged containers and host namespace sharing in Kubernetes workloads.', category: 'SECURITY', defaultSeverity: 'CRITICAL', check() { } },
    { id: 'IAC-002', name: 'Kubernetes Privilege Escalation', description: 'Detects Kubernetes containers that explicitly allow privilege escalation or root execution.', category: 'SECURITY', defaultSeverity: 'HIGH', check() { } },
    { id: 'IAC-003', name: 'Public Administrative Ingress', description: 'Detects Terraform security-group ingress exposing administrative ports to the internet.', category: 'SECURITY', defaultSeverity: 'HIGH', check() { } },
];
