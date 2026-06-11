import { Router } from "express";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateApiKeyBody, DeleteApiKeyParams, UpdateApiKeyParams, UpdateApiKeyBody } from "@workspace/api-zod";

const router = Router();

function generateApiKey(): string {
  const random = randomUUID().replace(/-/g, "");
  return `gw_${random}`;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 5) + "****" + key.slice(-4);
}

router.get("/keys", async (req, res) => {
  try {
    const keys = await db.select().from(apiKeysTable).orderBy(apiKeysTable.createdAt);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPreview: k.keyPreview,
        createdAt: k.createdAt.toISOString(),
        lastUsed: k.lastUsed?.toISOString() ?? null,
        requestCount: k.requestCount,
        isActive: k.isActive,
      })),
      total: keys.length,
    });
  } catch (err) {
    req.log.error({ err }, "List keys error");
    res.status(500).json({ error: "Failed to list API keys" });
  }
});

router.post("/keys", async (req, res) => {
  const parsed = CreateApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const key = generateApiKey();
  const id = randomUUID();

  try {
    await db.insert(apiKeysTable).values({
      id,
      name: parsed.data.name,
      keyHash: hashKey(key),
      keyPreview: maskKey(key),
      isActive: true,
    });

    const now = new Date().toISOString();
    res.status(201).json({
      id,
      name: parsed.data.name,
      key,
      keyPreview: maskKey(key),
      createdAt: now,
      isActive: true,
    });
  } catch (err) {
    req.log.error({ err }, "Create key error");
    res.status(500).json({ error: "Failed to create API key" });
  }
});

router.delete("/keys/:id", async (req, res) => {
  const parsed = DeleteApiKeyParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid key ID" });
    return;
  }

  try {
    await db.delete(apiKeysTable).where(eq(apiKeysTable.id, parsed.data.id));
    res.json({ success: true, message: "API key deleted" });
  } catch (err) {
    req.log.error({ err }, "Delete key error");
    res.status(500).json({ error: "Failed to delete API key" });
  }
});

router.patch("/keys/:id", async (req, res) => {
  const paramsParsed = UpdateApiKeyParams.safeParse(req.params);
  const bodyParsed = UpdateApiKeyBody.safeParse(req.body);

  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    const updates: Partial<typeof apiKeysTable.$inferInsert> = {};
    if (bodyParsed.data.isActive !== undefined) updates.isActive = bodyParsed.data.isActive;
    if (bodyParsed.data.name !== undefined) updates.name = bodyParsed.data.name;

    await db.update(apiKeysTable).set(updates).where(eq(apiKeysTable.id, paramsParsed.data.id));

    const rows = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, paramsParsed.data.id));
    const k = rows[0];
    if (!k) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    res.json({
      id: k.id,
      name: k.name,
      keyPreview: k.keyPreview,
      createdAt: k.createdAt.toISOString(),
      lastUsed: k.lastUsed?.toISOString() ?? null,
      requestCount: k.requestCount,
      isActive: k.isActive,
    });
  } catch (err) {
    req.log.error({ err }, "Update key error");
    res.status(500).json({ error: "Failed to update API key" });
  }
});

export default router;
