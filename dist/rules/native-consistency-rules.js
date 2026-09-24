"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_CONSISTENCY_RULES = void 0;
// Execution lives in verifyNativeConsistency (src/native-consistency.ts) because
// this rule needs the whole project: JS imports, node_modules podspecs, and ios/Podfile.lock.
exports.NATIVE_CONSISTENCY_RULES = [
    {
        id: "NAT-001",
        name: "Native Module Missing From Podfile.lock",
        description: "Detects JS-imported packages that declare an iOS native pod which is absent from ios/Podfile.lock — the installed native app is stale and will crash when the module is used.",
        category: "REACT_NATIVE_EXPO",
        defaultSeverity: "HIGH",
        check() { },
    },
];
