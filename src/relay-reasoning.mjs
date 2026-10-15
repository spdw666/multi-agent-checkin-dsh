// Same-model relay changes the supplier, not the conversation or the model ID.
// A catalogue boolean is not a declaration of an adjustable reasoning level.
const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OFF = new Set(['none', 'off', 'disabled']);
const ON = new Set(['on', 'enabled']);
const WIRE_METADATA = new Set([...ORDER, ...OFF, ...ON, 'light', 'heavy', 'extra_high']);
const wireLabel = value => value == null ? null : WIRE_METADATA.has(value) ? value : 'declared_native';
const CONTROLS = new Set([
  'reasoning_effort', 'reasoningEffort', 'reasoning', 'thinking',
  'thinking_level', 'thinkingLevel', 'thinking_mode', 'enable_thinking',
  'disable_thinking', 'reasoning_budget', 'thinking_budget', 'budget_tokens',
  'min_thinking_tokens', 'max_thinking_tokens', 'low_effort',
  'thinking_config', 'thinkingConfig', 'reasoning_config', 'reasoningConfig',
  'enableThinking', 'disableThinking', 'thinkingBudget', 'reasoningBudget',
  'thinking_budget_tokens', 'reasoning_budget_tokens', 'thinkingBudgetTokens',
  'reasoningBudgetTokens', 'reasoning_enabled', 'reasoningEnabled',
  'thinking_type', 'thinkingType', 'thinking_format', 'thinkingFormat',
  'include_thoughts', 'includeThoughts',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => typeof value === 'string'
  ? OFF.has(value) ? 'off' : ON.has(value) ? 'on' : ORDER.includes(value) ? value : null
  : null;
const rank = value => ORDER.indexOf(value);

function contract(model = {}, kind) {
  const reasoning = record(model?.reasoning) ? model.reasoning : {};
  const mappings = new Map();
  for (const table of [model?.reasoningEfforts, model?.thinkingLevelMap, model?.reasoningEffortMapping]) {
    if (!record(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      const level = canonical(key);
      if (level && typeof value === 'string' && value && !mappings.has(level)) mappings.set(level, value);
    }
  }
  const supported = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts
    : Array.isArray(reasoning.supported) ? reasoning.supported : [];
  for (const value of supported) {
    const level = canonical(value);
    if (level && !mappings.has(level)) mappings.set(level, value);
  }
  const nativeOptions = Array.isArray(model?.reasoningOptions) ? model.reasoningOptions : null;
  if (nativeOptions) for (const value of nativeOptions) {
    const level = canonical(value);
    if (level && !mappings.has(level)) mappings.set(level, value);
  }
  // reasoningEffortMapping may contain aliases such as medium -> high. Use
  // actual native options, when supplied, to determine the maximum, not aliases.
  let tiers = [...mappings].filter(([key, wire]) => ORDER.includes(key)
    && (!nativeOptions || nativeOptions.includes(wire)));
  if (nativeOptions) tiers = tiers.filter(([key, wire]) => key === wire
    || !mappings.has(wire));
  const actualTiers = new Map();
  for (const entry of tiers) {
    const [key, wire] = entry, previous = actualTiers.get(wire);
    if (!previous || key === wire || previous[0] !== wire && rank(key) < rank(previous[0]))
      actualTiers.set(wire, entry);
  }
  tiers = [...actualTiers.values()];
  const binaryWires = [...mappings.values()].filter(value => ON.has(value) || OFF.has(value));
  const thinkingTypes = reasoning.supportedThinkingTypes ?? model?.thinking?.supportedTypes;
  const hasOnlySwitches = tiers.every(([, wire]) => ON.has(wire) || OFF.has(wire));
  const binary = hasOnlySwitches && (Array.isArray(thinkingTypes) && thinkingTypes.includes('enabled')
    || binaryWires.some(value => ON.has(value)));
  if (binary) tiers = [];
  tiers.sort(([a], [b]) => rank(a) - rank(b));
  const alwaysEnabled = reasoning.alwaysEnabled === true || reasoning.onlyReasoning === true
    || model?.onlyReasoning === true;
  const off = alwaysEnabled ? null : mappings.get('off')
    ?? (Array.isArray(thinkingTypes) && thinkingTypes.includes('disabled') ? 'disabled' : null);
  return {
    mappings, tiers, binary, off, alwaysEnabled,
    maximum: tiers.at(-1) ?? null,
    thinkingControl: reasoning.control === 'thinking' || reasoning.control === 'thinking+effort'
      || Array.isArray(thinkingTypes) || kind === 'bigmodel',
  };
}

function inputIntent(request) {
  const extra = record(request?.extra_body) ? request.extra_body : {};
  const bodies = [request ?? {}, extra];
  // A null from the SDK is absent. It never masks another non-null intent.
  for (const body of bodies) if (typeof body.reasoning_effort === 'string' && body.reasoning_effort)
    return body.reasoning_effort;
  for (const body of bodies) {
    const values = [body.reasoningEffort, body.reasoning?.effort, body.thinking?.level,
      body.thinking_level, body.thinkingLevel, body.lobsterai_options?.thinking?.level,
      body.thinking_config?.thinking_level, body.thinkingConfig?.thinkingLevel,
      body.reasoning_config?.effort, body.reasoningConfig?.effort,
      body.chat_template_kwargs?.reasoning_effort, body.chat_template_args?.reasoning_effort];
    const effort = values.find(value => typeof value === 'string' && value);
    if (effort) return effort;
  }
  for (const body of bodies) {
    const type = body.thinking?.type ?? body.thinking_type ?? body.thinkingType;
    if (typeof type === 'string' && (ON.has(type) || OFF.has(type))) return type;
    for (const value of [body.thinking, body.enable_thinking, body.enableThinking,
      body.reasoning?.enabled, body.reasoning_enabled, body.reasoningEnabled,
      body.chat_template_kwargs?.enable_thinking, body.chat_template_args?.enable_thinking])
      if (typeof value === 'boolean') return value ? 'on' : 'off';
  }
  return null;
}

function resolveIntent(value, source) {
  if (!value) return null;
  const level = canonical(value);
  if (level && source.mappings.has(level)) return level;
  // The original Trae request can already carry heavy/light instead of high/low.
  const candidates = [...source.mappings].filter(([, wire]) => wire === value);
  const native = candidates.find(([key]) => key === value) ?? candidates.at(-1);
  if (native) return native[0];
  if (level === 'off' && source.off) return level;
  if (level === 'on' && (source.binary || source.tiers.length)) return level;
  return null;
}

function stripControls(body, prefix, removed) {
  const output = {...body};
  for (const key of CONTROLS) if (Object.hasOwn(output, key)) {
    delete output[key]; removed.push(prefix + key);
  }
  for (const key of ['chat_template_kwargs', 'chat_template_args']) if (record(output[key])) {
    const cleaned = stripControls(output[key], prefix + key + '.', removed);
    if (Object.keys(cleaned).length) output[key] = cleaned;
    else delete output[key];
  }
  // This object is a source-specific control envelope, not message/tool data.
  if (Object.hasOwn(output, 'lobsterai_options')) {
    delete output.lobsterai_options; removed.push(prefix + 'lobsterai_options');
  }
  return output;
}

/**
 * Adapt only an actual relay attempt. The caller supplies the ORIGINAL source
 * catalogue entry on every retry; it must not chain one target's adapted body
 * into the next target. No prompt, tool, output limit, stream, or ID is changed.
 */
export function adaptRelayReasoning(request, model, {kind, sourceModel, relayed = true} = {}) {
  if (!relayed) return {request, metadata:{mode:'unchanged', changed:false}};
  const source = contract(sourceModel);
  const target = contract(model, kind);
  const rawIntent = inputIntent(request);
  const sourceIntent = sourceModel === undefined ? canonical(rawIntent) : resolveIntent(rawIntent, source);
  const sourceHasLevels = source.tiers.length > 0;
  const forceMaximum = sourceModel !== undefined && !sourceHasLevels;
  const removedFields = [];
  const output = stripControls(request, '', removedFields);
  if (record(output.extra_body)) output.extra_body = stripControls(output.extra_body, 'extra_body.', removedFields);
  const metadata = {
    mode:'omitted', changed:removedFields.length > 0,
    sourceIntent:sourceIntent ?? (rawIntent === null ? null : 'unrecognized'),
    sourceHasLevels, targetEffort:null, wireEffort:null,
    targetMaximum:target.maximum?.[0] ?? null, removedFields,
  };
  if (target.binary) {
    const disabled = sourceIntent === 'off' && !target.alwaysEnabled && target.off !== null;
    // Binary controls mean enabled/disabled; they are never a fictional max tier.
    const type = disabled ? 'disabled' : 'enabled';
    const genericWire = disabled ? target.off : target.mappings.get('on')
      ?? [...target.mappings.values()].find(value => ON.has(value));
    if (target.thinkingControl) output.thinking = {type};
    else if (genericWire) output.reasoning_effort = genericWire;
    Object.assign(metadata, {mode:'binary', changed:true, targetEffort:disabled ? 'off' : 'on',
      wireEffort:wireLabel(target.thinkingControl ? type : genericWire)});
  } else if (target.maximum) {
    let choice;
    if (!forceMaximum && sourceIntent === 'off' && target.off !== null) choice = ['off', target.off];
    else if (forceMaximum || !sourceIntent || sourceIntent === 'on' || sourceIntent === 'off' || sourceIntent === 'max')
      choice = target.maximum;
    else {
      const declared = target.mappings.get(sourceIntent);
      const aliases = target.tiers.filter(([, wire]) => wire === declared);
      choice = aliases.find(([key]) => key === sourceIntent) ?? aliases.at(-1)
        ?? target.tiers.find(([key]) => rank(key) >= rank(sourceIntent)) ?? target.maximum;
    }
    const [level, wire] = choice;
    // Lobster's adapter translates canonical keys into its declared envelope.
    // A native thinking switch alone does not declare disabled as a legal
    // reasoning_effort value. Leave effort absent in that one case.
    if (!(level === 'off' && wire === 'disabled' && target.thinkingControl))
      output.reasoning_effort = kind === 'lobster' ? level : wire;
    if (target.thinkingControl) output.thinking = {type:level === 'off' ? 'disabled' : 'enabled'};
    Object.assign(metadata, {
      mode:forceMaximum || !sourceIntent ? 'maximum' : level === sourceIntent ? 'preserved' : 'mapped',
      changed:true, targetEffort:level, wireEffort:wireLabel(wire),
    });
  }
  return {request:output, metadata};
}
