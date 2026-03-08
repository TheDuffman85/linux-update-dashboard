import { Hono } from "hono";
import * as credentialService from "../services/credential-service";

const credentialsRouter = new Hono();

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

credentialsRouter.get("/", (c) => {
  const kind = c.req.query("kind");
  const credentials = credentialService.listCredentials({
    kind: kind as credentialService.CredentialKind | undefined,
  });
  return c.json({ credentials });
});

credentialsRouter.get("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid credential ID" }, 400);
  const credential = credentialService.getCredential(id);
  if (!credential) return c.json({ error: "Credential not found" }, 404);
  return c.json({ credential });
});

credentialsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const kind = body.kind as credentialService.CredentialKind;
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? body.payload as Record<string, string>
    : {};
  const error = credentialService.validateCredentialInput({
    name: String(body.name || ""),
    kind,
    payload,
  });
  if (error) return c.json({ error }, 400);

  const id = credentialService.createCredential({
    name: String(body.name),
    kind,
    payload,
  });
  return c.json({ id }, 201);
});

credentialsRouter.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid credential ID" }, 400);

  const existing = credentialService.getCredentialRow(id);
  if (!existing) return c.json({ error: "Credential not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? body.payload as Record<string, string>
    : {};
  const error = credentialService.validateCredentialInput({
    name: String(body.name || ""),
    kind: existing.kind as credentialService.CredentialKind,
    payload,
  }, credentialService.parseCredentialPayload(existing.payload));
  if (error) return c.json({ error }, 400);

  credentialService.updateCredential(id, {
    name: String(body.name),
    payload,
  });
  return c.json({ ok: true });
});

credentialsRouter.delete("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid credential ID" }, 400);

  const result = credentialService.deleteCredential(id);
  if (!result.ok) {
    if (result.references) {
      return c.json({
        error: "Credential is still in use",
        references: result.references,
      }, 409);
    }
    return c.json({ error: "Credential not found" }, 404);
  }

  return c.json({ ok: true });
});

export default credentialsRouter;
