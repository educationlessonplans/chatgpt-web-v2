import { V2Error } from "./errors.ts";

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface EmulatedToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deliberately small strict JSON-Schema subset suitable for emulated tool compatibility. */
export function validateJsonSchema(value: unknown, schema: Record<string, any>, path = "$", errors: string[] = []): string[] {
  const type = schema?.type;
  if (type === "object") {
    if (!isObject(value)) errors.push(`${path} must be an object`);
    else {
      for (const required of schema.required || []) if (!(required in value)) errors.push(`${path}.${required} is required`);
      for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) validateJsonSchema(value[key], child as Record<string, any>, `${path}.${key}`, errors);
      if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key} is not allowed`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) errors.push(`${path} must be an array`);
    else if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`, errors));
  } else if (type === "string" && typeof value !== "string") errors.push(`${path} must be a string`);
  else if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push(`${path} must be a number`);
  else if (type === "integer" && (!Number.isInteger(value))) errors.push(`${path} must be an integer`);
  else if (type === "boolean" && typeof value !== "boolean") errors.push(`${path} must be a boolean`);
  if (schema.enum && !schema.enum.some((item: unknown) => Object.is(item, value))) errors.push(`${path} must match enum`);
  return errors;
}

export function validateToolArguments(tool: ToolDefinition, rawArguments: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawArguments || "{}"); } catch (error) { throw new V2Error(`Tool ${tool.function.name} arguments are not valid JSON.`, { category: "invalid_request", status: 400, code: "INVALID_TOOL_ARGUMENTS", cause: error }); }
  const errors = validateJsonSchema(parsed, tool.function.parameters || { type: "object" });
  if (errors.length) throw new V2Error(`Tool ${tool.function.name} arguments failed schema validation: ${errors.join("; ")}`, { category: "invalid_request", status: 400, code: "INVALID_TOOL_ARGUMENTS" });
  return parsed as Record<string, unknown>;
}

/** Parse the audited <tool>{...}</tool> compatibility format with exact-name preference. */
export function parseEmulatedToolCalls(text: string, tools: ToolDefinition[]): EmulatedToolCall[] {
  const calls: EmulatedToolCall[] = [];
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  const pattern = /<tool\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool>/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const definition = byName.get(name);
    if (!definition) throw new V2Error(`Unknown tool requested: ${name}.`, { category: "invalid_request", status: 400, code: "UNKNOWN_TOOL" });
    validateToolArguments(definition, match[2].trim());
    calls.push({ id: `call_${calls.length + 1}`, type: "function", function: { name, arguments: match[2].trim() } });
  }
  return calls;
}

export function toolChoiceName(choice: unknown): string | null {
  if (choice === "none" || choice == null) return null;
  if (choice === "auto") return null;
  if (typeof choice === "object" && (choice as any).function?.name) return String((choice as any).function.name);
  return null;
}
