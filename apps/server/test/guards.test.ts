/**
 * RBAC guard matrix (spec 3): requireAuth (401 unauthenticated, 403 banned),
 * requireRole (403 wrong role), requireEmployeeSelf (403 no employee record,
 * 404 cross-tenant — no enumeration).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authUser, company, employees } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function linkEmployee(userId: string, legalName: string): Promise<number> {
  const [co] = await t.db.insert(company).values({ legalName: "Test Co" }).returning();
  const [emp] = await t.db
    .insert(employees)
    .values({ userId, companyId: co!.id, legalName, hireDate: "2025-01-01" })
    .returning();
  return emp!.id;
}

describe("requireAuth", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects banned users holding a live session with 403 account_disabled", async () => {
    const email = "banned-guard@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const { sessionCookie } = await login(t, email, TEST_PASSWORD);

    // Ban directly in the DB (the BA admin ban endpoint would also kill the
    // session, which is a separate behavior tested in sessions.test.ts).
    await t.db
      .update(authUser)
      .set({ banned: true, banReason: "admin_action" })
      .where(eq(authUser.id, userId));

    const res = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: sessionHeader(sessionCookie),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_disabled");
  });
});

describe("requireRole", () => {
  it("rejects employees from admin routes with 403, admits admins", async () => {
    await inviteAndOnboard(t, { email: "emp-role@example.com", role: "employee" });
    const empLogin = await login(t, "emp-role@example.com", TEST_PASSWORD);
    const denied = await t.app.inject({
      method: "GET",
      url: "/api/admin/ping",
      headers: sessionHeader(empLogin.sessionCookie),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("forbidden");

    await inviteAndOnboard(t, { email: "adm-role@example.com", role: "admin" });
    const admLogin = await login(t, "adm-role@example.com", TEST_PASSWORD);
    const allowed = await t.app.inject({
      method: "GET",
      url: "/api/admin/ping",
      headers: sessionHeader(admLogin.sessionCookie),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().scope).toBe("admin");
  });
});

describe("requireEmployeeSelf", () => {
  it("serves own record, 404s cross-tenant, 403s users with no employee record", async () => {
    const email = "self@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const employeeId = await linkEmployee(userId, "Self Employee");
    const { sessionCookie } = await login(t, email, TEST_PASSWORD);

    const own = await t.app.inject({
      method: "GET",
      url: `/api/employees/${employeeId}/ping`,
      headers: sessionHeader(sessionCookie),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().employeeId).toBe(employeeId);

    // Cross-tenant: another employee id must look like it does not exist.
    const other = await t.app.inject({
      method: "GET",
      url: `/api/employees/${employeeId + 1000}/ping`,
      headers: sessionHeader(sessionCookie),
    });
    expect(other.statusCode).toBe(404);

    // A real second employee belonging to someone else → also 404.
    const otherEmail = "other-emp@example.com";
    const { userId: otherUserId } = await inviteAndOnboard(t, { email: otherEmail });
    const otherEmployeeId = await linkEmployee(otherUserId, "Other Employee");
    const cross = await t.app.inject({
      method: "GET",
      url: `/api/employees/${otherEmployeeId}/ping`,
      headers: sessionHeader(sessionCookie),
    });
    expect(cross.statusCode).toBe(404);

    // User with no employee row at all → 403 no_employee_record.
    const noRecEmail = "no-record@example.com";
    await inviteAndOnboard(t, { email: noRecEmail });
    const noRecLogin = await login(t, noRecEmail, TEST_PASSWORD);
    const noRec = await t.app.inject({
      method: "GET",
      url: `/api/employees/${otherEmployeeId}/ping`,
      headers: sessionHeader(noRecLogin.sessionCookie),
    });
    expect(noRec.statusCode).toBe(403);
    expect(noRec.json().error).toBe("no_employee_record");
  });
});
