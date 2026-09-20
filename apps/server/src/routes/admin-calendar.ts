/**
 * Admin calendar route (PAY-40): GET /api/admin/calendar?year=&month= — one
 * month of company date obligations (paydays, contractor invoice/payment
 * days, deposit due/actual dates, filing deadlines/filings, W-8 expiries)
 * as a flat, date-sorted, read-only event list for the month-grid UI.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Guards } from "../plugins/guards.js";
import { monthCalendar } from "../calendar/service.js";

interface Deps {
  db: Db;
  guards: Guards;
}

const query = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export function registerAdminCalendarRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/calendar", { preHandler: admin }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    const events = await monthCalendar(db, q.data.year, q.data.month);
    return { year: q.data.year, month: q.data.month, events };
  });
}
