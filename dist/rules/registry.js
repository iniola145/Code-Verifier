"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RULE_REGISTRY = exports.REGISTERED_RULES = void 0;
exports.getRuleMetadata = getRuleMetadata;
exports.validateRuleRegistry = validateRuleRegistry;
const react_native_rules_1 = require("./react-native-rules");
const METADATA = {
    'RN-SEC-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'] },
    'RN-SEC-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'] },
    'RN-SEC-003': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion' },
    'REACT-001': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'] },
    'REACT-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'] },
    'REACT-003': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://react.dev/reference/react/useEffect' },
    'SEC-003': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'AI-NULL-001': { confidence: 'MEDIUM', requirements: ['AST', 'CFG', 'ABSTRACT_INTERPRETATION'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'AI-TAINT-001': { confidence: 'HIGH', requirements: ['AST', 'CFG', 'ABSTRACT_INTERPRETATION'], frameworks: ['REACT_NATIVE', 'EXPO'] },
    'SEC-004': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'SEC-005': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'WEB'] },
    'SEC-006': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['WEB', 'REACT'] },
    'SEC-007': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/78.html' },
    'SEC-008': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/89.html' },
    'SEC-009': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/918.html' },
    'SEC-010': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/22.html' },
    'SEC-011': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://cwe.mitre.org/data/definitions/338.html' },
    'SEC-012': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/1321.html' },
    'SEC-013': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://cwe.mitre.org/data/definitions/532.html' },
    'SEC-014': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://github.com/auth0/node-jsonwebtoken#jwtdecodetoken--options' },
    'SEC-015': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/915.html' },
    'SEC-016': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html' },
    'SEC-017': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/942.html' },
    'LOGIC-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'LOGIC-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map' },
    'LOGIC-003': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'ASYNC-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach' },
    'ASYNC-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'REACT-004': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://react.dev/reference/react/useEffect' },
    'REACT-005': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://react.dev/learn/rendering-lists' },
    'REACT-006': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://react.dev/reference/react/useEffect#updating-state-based-on-previous-state-from-an-effect' },
    'REACT-007': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://react.dev/reference/react/useRef' },
    'REACT-008': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT', 'REACT_NATIVE', 'EXPO'] },
    'RN-COR-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://reactnative.dev/docs/flatlist#keyextractor' },
    'RN-COR-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://reactnative.dev/docs/animations' },
    'RN-COR-003': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://reactnative.dev/docs/animations' },
    'RN-COR-004': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://reactnative.dev/docs/panresponder' },
    'REL-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'REL-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'QUAL-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map' },
    'TYPE-001': { confidence: 'HIGH', requirements: ['AST', 'TYPE_INFORMATION', 'PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://typescript-eslint.io/rules/no-floating-promises/' },
    'TYPE-002': { confidence: 'HIGH', requirements: ['AST', 'TYPE_INFORMATION', 'PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://typescript-eslint.io/rules/no-misused-promises/' },
    'MOB-001': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.android.com/privacy-and-security/risks/backup-best-practices' },
    'MOB-002': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloads' },
    'MOB-003': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.android.com/privacy-and-security/risks/access-control-to-exported-components' },
    'MOB-004': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.android.com/privacy-and-security/risks/android-debuggable' },
    'MOB-005': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.apple.com/documentation/bundleresources/information-property-list/uifilesharingenabled' },
    'MOB-006': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.android.com/privacy-and-security/minimize-permission-requests' },
    'API-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/209.html' },
    'API-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html' },
    'API-003': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'] },
    'AUTH-001': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'WEB'], documentationUrl: 'https://cwe.mitre.org/data/definitions/862.html' },
    'SUP-001': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions' },
    'SUP-002': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions' },
    'SUP-003': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.docker.com/reference/build-checks/secrets-used-in-arg-or-env/' },
    'SUP-004': { confidence: 'MEDIUM', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.docker.com/build/building/best-practices/' },
    'IAC-001': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://kubernetes.io/docs/concepts/security/pod-security-standards/' },
    'IAC-002': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://kubernetes.io/docs/concepts/security/pod-security-standards/' },
    'IAC-003': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'], documentationUrl: 'https://developer.hashicorp.com/terraform/language/resources/syntax' },
    'WEB-001': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['WEB', 'REACT'] },
    'WEB-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['WEB', 'REACT'], documentationUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage' },
    'HYG-001': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'HYG-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'NET-001': { confidence: 'MEDIUM', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB', 'REACT_NATIVE', 'EXPO'] },
    'NET-002': { confidence: 'HIGH', requirements: ['AST'], frameworks: ['TYPESCRIPT', 'REACT', 'WEB'], documentationUrl: 'https://nodejs.org/api/tls.html' },
    'NAV-001': { confidence: 'HIGH', requirements: ['AST', 'PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.expo.dev/router/basics/notation/' },
    'NAT-001': { confidence: 'HIGH', requirements: ['PROJECT_CONTEXT'], frameworks: ['REACT_NATIVE', 'EXPO'], documentationUrl: 'https://docs.expo.dev/modules/autolinking/' },
};
function metadataFor(rule) {
    const extra = METADATA[rule.id];
    if (!extra)
        throw new Error(`Rule ${rule.id} is missing registry metadata.`);
    return {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        category: rule.category,
        defaultSeverity: rule.defaultSeverity,
        cweId: rule.cweId,
        ...extra,
    };
}
exports.REGISTERED_RULES = [...react_native_rules_1.ALL_RULES];
exports.RULE_REGISTRY = new Map(exports.REGISTERED_RULES.map((rule) => [rule.id, metadataFor(rule)]));
function getRuleMetadata(ruleId) {
    return exports.RULE_REGISTRY.get(ruleId);
}
function validateRuleRegistry(rules = exports.REGISTERED_RULES) {
    const errors = [];
    const ids = new Set();
    for (const rule of rules) {
        if (ids.has(rule.id))
            errors.push(`Duplicate rule id: ${rule.id}`);
        ids.add(rule.id);
        if (!exports.RULE_REGISTRY.has(rule.id))
            errors.push(`Missing metadata for rule: ${rule.id}`);
    }
    return errors;
}
