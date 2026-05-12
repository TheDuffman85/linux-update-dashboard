import { Hono } from "hono";
import * as scriptService from "../services/script-service";

const scripts = new Hono();
const MAX_PARSER_SAMPLE_OUTPUT_LENGTH = 50_000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

scripts.get("/", (c) => {
  return c.json(scriptService.listScripts());
});

scripts.post("/", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const script = scriptService.createScript(body as Partial<scriptService.ScriptDefinition>);
    return c.json({ script }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create script" }, 400);
  }
});

scripts.post("/package-managers", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const manager = scriptService.createCustomPackageManager({
      name: typeof body.name === "string" ? body.name : "",
      label: typeof body.label === "string" ? body.label : "",
      color: typeof body.color === "string" ? body.color : null,
      parserConfig: asObject(body.parserConfig) as scriptService.CustomParserConfig | null,
      configEntries: Array.isArray(body.configEntries) ? body.configEntries : undefined,
    });
    return c.json({ manager }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create package manager" }, 400);
  }
});

scripts.put("/package-managers/:name", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const manager = scriptService.updateCustomPackageManager(c.req.param("name"), {
      label: typeof body.label === "string" ? body.label : "",
      color: typeof body.color === "string" ? body.color : null,
      parserConfig: asObject(body.parserConfig) as scriptService.CustomParserConfig | null,
      configEntries: Array.isArray(body.configEntries) ? body.configEntries : undefined,
    });
    return c.json({ manager });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update package manager" }, 400);
  }
});

scripts.delete("/package-managers/:name", (c) => {
  try {
    scriptService.deleteCustomPackageManager(c.req.param("name"));
    return c.json({ status: "ok" });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to delete package manager" }, 400);
  }
});

scripts.post("/validate-parser", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  const output = typeof body.output === "string" ? body.output : "";
  if (output.length > MAX_PARSER_SAMPLE_OUTPUT_LENGTH) {
    return c.json({ error: `output must be ${MAX_PARSER_SAMPLE_OUTPUT_LENGTH} characters or less` }, 400);
  }
  const pkgManager = typeof body.pkgManager === "string" ? body.pkgManager : "custom";
  const parserConfig = asObject(body.parserConfig) as scriptService.CustomParserConfig | null;
  try {
    const updates = scriptService.parseCustomUpdates(pkgManager, parserConfig, [{
      command: "sample",
      stdout: output,
      stderr: "",
      exitCode: 0,
    }]);
    return c.json({ updates });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Parser validation failed" }, 400);
  }
});

scripts.post("/format", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  const command = typeof body.command === "string" ? body.command : "";
  try {
    return c.json({ command: await scriptService.formatShellCommand(command) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to format command" }, 400);
  }
});

scripts.put("/:id", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const script = scriptService.updateScript(c.req.param("id"), body as Partial<scriptService.ScriptDefinition>);
    return c.json({ script });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update script" }, 400);
  }
});

scripts.delete("/:id", (c) => {
  try {
    scriptService.deleteScript(c.req.param("id"));
    return c.json({ status: "ok" });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to delete script" }, 400);
  }
});

export default scripts;
