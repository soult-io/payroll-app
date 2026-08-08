/**
 * Step-2 stub routes proving each guard class (spec 3 route classes).
 * Real business routes land in steps 3–4.
 */

import type { FastifyInstance } from "fastify";
import type { Guards } from "../plugins/guards.js";

export function registerStubRoutes(app: FastifyInstance, guards: Guards): void {
  app.get("/api/me", { preHandler: guards.requireAuth }, async (req) => ({
    user: {
      id: req.authUser!.id,
      email: req.authUser!.email,
      name: req.authUser!.name,
      role: req.authUser!.role ?? "employee",
      twoFactorEnabled: req.authUser!.twoFactorEnabled ?? false,
    },
    session: {
      id: req.authSession!.id,
      expiresAt: req.authSession!.expiresAt,
    },
  }));

  app.get("/api/admin/ping", { preHandler: guards.requireRole("admin") }, async (req) => ({
    ok: true,
    scope: "admin",
    by: req.authUser!.id,
  }));

  app.get(
    "/api/employees/:employeeId/ping",
    { preHandler: guards.requireEmployeeSelf("employeeId") },
    async (req) => ({
      ok: true,
      scope: "employee-self",
      employeeId: req.employee!.id,
    }),
  );
}
