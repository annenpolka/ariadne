import { HostError, type ScopeGrant } from './contracts.js';
import { browserOrigin, chromeAppId, validateReadLimits } from './browser-policy.js';
import { validateContract } from './validation.js';

export const browserSetValueRoles = ['AXTextField', 'AXTextArea', 'AXComboBox'];
export const browserInvokeRoles = ['AXButton', 'AXPopUpButton', 'AXMenuButton', 'AXMenuItem', 'AXCheckBox', 'AXRadioButton', 'AXLink', 'AXDisclosureTriangle'];

export function validateGrant(value: unknown): asserts value is ScopeGrant {
  const invalid = (): never => { throw new HostError('invalid_request', 'Invalid operator grant'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  const fields = ['scopeRef', 'grantRef', 'version', 'read', 'model', 'act', 'allowedCommands', 'appId', 'windowRef', 'limits'];
  if (Object.keys(v).some(k => !fields.includes(k) && !['allowedActions', 'pageScope', 'readLimits', 'actionPolicy'].includes(k)) || fields.some(k => !Object.hasOwn(v, k))) return invalid();
  if (v.allowedActions !== undefined && (!Array.isArray(v.allowedActions) || v.allowedActions.some(x => !['fixture.submit', 'fixture.replace_field', 'fixture.show_modal'].includes(x)) || new Set(v.allowedActions).size !== v.allowedActions.length)) return invalid();
  if (![v.scopeRef, v.grantRef, v.appId, v.windowRef].every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x))) return invalid();
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1 || ![v.read, v.model, v.act].every(x => typeof x === 'boolean')) return invalid();
  if (!Array.isArray(v.allowedCommands) || v.allowedCommands.some(x => !['set_value', 'invoke'].includes(x)) || new Set(v.allowedCommands).size !== v.allowedCommands.length) return invalid();
  if (!v.limits || typeof v.limits !== 'object' || Array.isArray(v.limits)) return invalid();
  const limits = v.limits as Record<string, unknown>;
  if (Object.keys(limits).length !== 4 || !['maxOperations', 'maxSemanticRequests', 'maxObservationExpansions', 'deadlineMs'].every(k => Number.isSafeInteger(limits[k]) && (limits[k] as number) >= 0 && (limits[k] as number) <= 2_147_483_647)) return invalid();
  if (v.appId === chromeAppId) {
    if (!v.read || v.model || (Array.isArray(v.allowedActions) && v.allowedActions.length) || limits.maxSemanticRequests !== 0) return invalid();
    if (v.act) {
      const p = v.actionPolicy as ScopeGrant['actionPolicy'];
      if (!p || Object.keys(p).length !== 3 || !p.task || p.task.kind !== 'browser_action_task') return invalid();
      validateContract(p.task);
      if (p.task.scopeRef !== v.scopeRef || (limits.maxOperations as number) < p.task.steps.length || !v.allowedCommands.length) return invalid();
      for (const [roles, allowed] of [[p.setValueRoles, browserSetValueRoles], [p.invokeRoles, browserInvokeRoles]] as const) {
        if (!Array.isArray(roles) || new Set(roles).size !== roles.length || roles.some(role => !allowed.includes(role))) return invalid();
      }
      if (p.task.steps.some(step => !(v.allowedCommands as string[]).includes(step.kind))) return invalid();
    } else if (v.actionPolicy !== undefined || v.allowedCommands.length || limits.maxOperations !== 0) return invalid();
    validateReadLimits(v.readLimits);
    if (v.act) {
      const task = (v.actionPolicy as NonNullable<ScopeGrant['actionPolicy']>).task;
      const ceiling = v.readLimits as ScopeGrant['readLimits'];
      if (!ceiling || Object.entries(task.limits).some(([key, n]) => n > ceiling[key as keyof typeof ceiling]) || task.limits.deadlineMs > (limits.deadlineMs as number)) return invalid();
    }
    if (!v.pageScope || typeof v.pageScope !== 'object' || Array.isArray(v.pageScope)) return invalid();
    const scope = v.pageScope as Record<string, unknown>;
    if (Object.keys(scope).length !== 1 || !Array.isArray(scope.origins) || scope.origins.length < 1 || scope.origins.length > 16 || new Set(scope.origins).size !== scope.origins.length || scope.origins.some(x => typeof x !== 'string' || browserOrigin(x) !== x)) return invalid();
  } else if (v.pageScope !== undefined || v.readLimits !== undefined || v.actionPolicy !== undefined) return invalid();
}
