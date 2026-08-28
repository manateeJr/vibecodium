export interface ScopedAction<TType extends string = string> {
  readonly type: TType;
  readonly scope: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}

export interface AuthorityRule {
  readonly type: string;
  readonly scope?: Readonly<Record<string, string>>;
}

export interface AuthorityConfig {
  readonly protected: readonly AuthorityRule[];
  readonly permitted: readonly AuthorityRule[];
}

export interface AuthorityDecision {
  readonly allowed: boolean;
  readonly reason: 'protected' | 'permitted' | 'unpermitted' | 'invalid';
}

export class Authority {
  private readonly protectedRules: readonly AuthorityRule[];
  private readonly permittedRules: readonly AuthorityRule[];

  public constructor(config: Partial<AuthorityConfig> = {}) {
    this.protectedRules = config.protected ?? [];
    this.permittedRules = config.permitted ?? [];
  }

  public evaluate(action: ScopedAction): AuthorityDecision {
    if (
      !action ||
      typeof action.type !== 'string' ||
      action.type.length === 0 ||
      !isScope(action.scope)
    ) {
      return { allowed: false, reason: 'invalid' };
    }
    if (this.protectedRules.some((rule) => matchesRule(rule, action))) {
      return { allowed: false, reason: 'protected' };
    }
    if (this.permittedRules.some((rule) => matchesRule(rule, action))) {
      return { allowed: true, reason: 'permitted' };
    }
    return { allowed: false, reason: 'unpermitted' };
  }
}

function isScope(scope: unknown): scope is Readonly<Record<string, string>> {
  if (!scope || typeof scope !== 'object') return false;
  return Object.values(scope).every((value) => typeof value === 'string');
}

function matchesRule(rule: AuthorityRule, action: ScopedAction): boolean {
  if (rule.type !== '*' && rule.type !== action.type) return false;
  if (!rule.scope) return true;
  return Object.entries(rule.scope).every(
    ([key, value]) => value === '*' || action.scope[key] === value,
  );
}
