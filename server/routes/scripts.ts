import { Hono } from "hono";
import * as scriptService from "../services/script-service";

const scripts = new Hono();

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
    });
    return c.json({ manager }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create package manager" }, 400);
  }
});

scripts.post("/package-managers/copy-builtin", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const result = scriptService.copyBuiltinPackageManager({
      sourceManager: typeof body.sourceManager === "string" ? body.sourceManager : "",
      name: typeof body.name === "string" ? body.name : "",
      label: typeof body.label === "string" ? body.label : "",
      color: typeof body.color === "string" ? body.color : null,
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to copy package manager" }, 400);
  }
});

scripts.post("/validate-parser", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  const output = typeof body.output === "string" ? body.output : "";
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

scripts.post("/:id/copy", (c) => {
  try {
    const script = scriptService.copyScript(c.req.param("id"));
    return c.json({ script }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to copy script" }, 400);
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
