import { VerificationRule } from "../types/verifier";

// Execution lives in mobile-config.ts because these rules parse JSON, XML, and plist files.
export const MOBILE_CONFIG_RULES: VerificationRule[] = [
  {
    id: "MOB-001",
    name: "Sensitive Android Backup Enabled",
    description: "Detects explicitly enabled Android application backup.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "MEDIUM",
    check() {},
  },
  {
    id: "MOB-002",
    name: "Mobile Cleartext Transport Enabled",
    description:
      "Detects Android cleartext traffic and global iOS ATS opt-outs.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "HIGH",
    check() {},
  },
  {
    id: "MOB-003",
    name: "Unprotected Exported Android Component",
    description:
      "Detects exported Android components without a manifest permission.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "HIGH",
    check() {},
  },
  {
    id: "MOB-004",
    name: "Debuggable Production Application",
    description:
      "Detects Android applications explicitly shipped as debuggable.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "HIGH",
    check() {},
  },
  {
    id: "MOB-005",
    name: "iOS Document Sharing Enabled",
    description:
      "Detects iOS file sharing that exposes the app Documents directory.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "MEDIUM",
    check() {},
  },
  {
    id: "MOB-006",
    name: "High-Risk Android Permission",
    description:
      "Detects especially dangerous Android permissions in Expo configuration.",
    category: "REACT_NATIVE_EXPO",
    defaultSeverity: "HIGH",
    check() {},
  },
];
