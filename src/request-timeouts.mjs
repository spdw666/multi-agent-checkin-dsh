// The server and relay must use the same live whole-request budget.
export function gatewayRequestTimeout(policy={},routeId){return policy.modelRequestTimeouts&&Object.hasOwn(policy.modelRequestTimeouts,routeId)?policy.modelRequestTimeouts[routeId]:(policy.requestTimeoutMs??180000);}
