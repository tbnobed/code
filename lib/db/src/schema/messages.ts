import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sessionsTable } from "./sessions";

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessionsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant' | 'tool'
  content: text("content").notNull().default(""),
  toolCalls: text("tool_calls"), // JSON string of OpenAI tool calls
  toolCallId: text("tool_call_id"), // for role=tool responses
  mode: text("mode"), // 'architect' for architect-turn responses; null for normal turns
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
