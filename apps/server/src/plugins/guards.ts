/**
 * RBAC guards (spec 3 "RBAC") — Fastify preHandlers.
 *
 * - requireAuth: valid BA session + not banned + absolute/idle enforcement.
 *   Absolute 7d is fixed in the session row (BA refresh disabled); idle 12h is
 *   enforced here by touching session.updatedAt (throttled) and revoking when
 *   it is more than IDLE_MS behind.
 * - requireRole('admin'): server-side role check, never client claims.
 * - requireEmployeeSelf: resolves session user → employees row; cross-tenant
 *   access gets 404 (no enumeration), missing link gets 403.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { authSession, employees } from "@payroll/db";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import { writeAuthEvent, AUTH_EVENT, requestContext } from "../auth/audit.js";

type Employee = typeof employees.$inferSelect;

/** Idle timeout (spec 3: 12 hours). */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Avoid a write on every request. */
const TOUCH_THROTTLE_MS = 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role?: string | undefined;
  banned?: boolean | null | undefined;
  twoFactorEnabled?: boolean | null | undefined;
}

export interface SessionInfo {
  id: string;
  token?: string;
  userId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: SessionUser | null;
    authSession: SessionInfo | null;
    employee: Employee | null;
  }
}

function toHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(","));
  }
  return headers;
}

export { toHeaders };

export interface Guards {
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRole: (
    role: "admin" | "employee",
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireEmployeeSelf: (
    paramKey?: string,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function createGuards(deps: { auth: Auth; db: Db }): Guards {
  const { auth, db } = deps;

  async function loadSession(req: FastifyRequest) {
    const result = await auth.api.getSession({ headers: toHeaders(req) });
    if (!result) return null;
    return result as { session: SessionInfo; user: SessionUser };
  }

  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await loadSession(req);
    if (!result) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const { session, user } = result;
    if (user.banned) {
      await reply.code(403).send({ error: "account_disabled" });
      return;
    }
    // Idle enforcement: session.updatedAt is our last-activity marker (BA
    // session refresh is disabled, so nothing else moves it).
    const lastActivity = new Date(session.updatedAt).getTime();
    const now = Date.now();
    if (now - lastActivity > IDLE_TIMEOUT_MS) {
      if (session.token) {
        const ctx = await auth.$context;
        await ctx.internalAdapter.deleteSessions([session.token]);
      }
      await writeAuthEvent(db, AUTH_EVENT.sessionRevoked, user.id, requestContext(toHeaders(req)));
      await reply.code(401).send({ error: "session_expired" });
      return;
    }
    if (now - lastActivity > TOUCH_THROTTLE_MS) {
      await db
        .update(authSession)
        .set({ updatedAt: new Date(now) })
        .where(eq(authSession.id, session.id));
    }
    req.authUser = user;
    req.authSession = session;
  }

  function requireRole(role: "admin" | "employee") {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await requireAuth(req, reply);
      if (reply.sent) return;
      if (req.authUser?.role !== role) {
        await reply.code(403).send({ error: "forbidden" });
      }
    };
  }

  function requireEmployeeSelf(paramKey = "employeeId") {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await requireAuth(req, reply);
      if (reply.sent) return;
      const rows = await db
        .select()
        .from(employees)
        .where(eq(employees.userId, req.authUser!.id))
        .limit(1);
      const employee = rows[0];
      if (!employee) {
        await reply.code(403).send({ error: "no_employee_record" });
        return;
      }
      const param = (req.params as Record<string, string | undefined>)[paramKey];
      if (param !== undefined && Number(param) !== employee.id) {
        // 404 over 403: do not reveal that another employee id exists.
        await reply.code(404).send({ error: "not_found" });
        return;
      }
      req.employee = employee;
    };
  }

  return { requireAuth, requireRole, requireEmployeeSelf };
}
