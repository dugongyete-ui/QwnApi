import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gatewayConfigTable = pgTable("gateway_config", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GatewayConfig = typeof gatewayConfigTable.$inferSelect;
