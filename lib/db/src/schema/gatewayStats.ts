import { pgTable, text, integer, real, timestamp, boolean } from "drizzle-orm/pg-core";

export const gatewayStatsTable = pgTable("gateway_stats", {
  id: text("id").primaryKey().default("singleton"),
  totalRequests: integer("total_requests").notNull().default(0),
  successRequests: integer("success_requests").notNull().default(0),
  failedRequests: integer("failed_requests").notNull().default(0),
  totalResponseTime: real("total_response_time").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const requestLogsTable = pgTable("request_logs", {
  id: text("id").primaryKey(),
  success: boolean("success").notNull(),
  responseTime: integer("response_time").notNull().default(0),
  model: text("model").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type GatewayStat = typeof gatewayStatsTable.$inferSelect;
export type RequestLog = typeof requestLogsTable.$inferSelect;
