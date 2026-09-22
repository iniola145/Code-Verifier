import { RuleMetadata, VerificationRule } from '../types/verifier';
export declare const REGISTERED_RULES: VerificationRule[];
export declare const RULE_REGISTRY: Map<string, RuleMetadata>;
export declare function getRuleMetadata(ruleId: string): RuleMetadata | undefined;
export declare function validateRuleRegistry(rules?: VerificationRule[]): string[];
