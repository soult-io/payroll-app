/**
 * Typed API client (frontend spec: hand-maintained typed wrapper mirroring
 * apps/server/src/routes — OpenAPI codegen was aspirational; this is the
 * pragmatic choice and stays close to the real endpoints).
 *
 * Same-origin cookies carry the session; every function throws ApiError on
 * non-2xx so views can toast uniformly.
 */

// ---------------------------------------------------------------------------
// DTO types (mirror server responses)
// ---------------------------------------------------------------------------

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export type RunStatus = "draft" | "awaiting_approval" | "approved" | "issued" | "void";
export type RequestStatus = "pending" | "approved" | "denied" | "withdrawn";
export type ChangeRequestType = "address" | "w4" | "bank_details" | "legal_name" | "tax_id";

export interface PayslipSummary {
  publicId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: RunStatus;
  grossPay: number;
  netPay: number;
  snapshotHash: string;
  issuedAt: string | null;
}

export interface PayslipDetail extends PayslipSummary {
  snapshot: RunSnapshot;
}

/** PAY-7: a contractor-visible invoice (approved/paid only — D1). */
export interface MyInvoice {
  id: number;
  invoiceDate: string;
  description: string;
  amount: number;
  currency: string;
  status: "approved" | "paid";
  recurringPeriod: string | null;
  payment: {
    payDate: string;
    amount: number;
    method: string;
    reference: string | null;
    backupWithheld: number;
  } | null;
}

export interface RunSnapshot {
  inputs: {
    periodAmount: number;
    frequency: string;
    periodsPerYear: number;
    w4: Record<string, unknown> | null;
    taxConfig: Record<string, unknown>;
    brackets: { ordinal: number; minAmount: string; maxAmount: string | null; rate: string }[];
    priorYtdGross: number;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
  };
  result: {
    grossPay: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
    employerSocialSecurity: number;
    employerMedicare: number;
    employerFUTA: number;
    [key: string]: number;
  };
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (snapshot template ≥1.1.0). */
  ytd?: {
    gross: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
  };
  /** Legacy-import only: categories where the ISSUED amount differs from the recomputed result. */
  legacyDeviations?: {
    category: string;
    stored: string;
    recomputed: string;
    reason: string;
  }[];
}

/**
 * Amounts to SHOW on a payslip: engine result with documented legacy
 * deviations overridden to the issued (stored) figures. Mirrors
 * effectivePayslipAmounts() in @payroll/documents — keep in sync.
 */
export function effectivePayslipAmounts(snapshot: RunSnapshot): {
  federalWithholding: number;
  totalDeductions: number;
  netPay: number;
  deviations: { label: string; stored: number; recomputed: number }[];
} {
  const LABELS: Record<string, string> = {
    gross_pay: "Gross Pay",
    federal_withholding: "Federal Income Tax",
    social_security: "Social Security",
    medicare: "Medicare",
    state_withholding: "State Income Tax",
    net_pay: "Net Pay",
  };
  let federal = snapshot.result.federalWithholding;
  let net = snapshot.result.netPay;
  const deviations = (snapshot.legacyDeviations ?? []).map((d) => {
    if (d.category === "federal_withholding") federal = Number(d.stored);
    if (d.category === "net_pay") net = Number(d.stored);
    return {
      label: LABELS[d.category] ?? d.category,
      stored: Number(d.stored),
      recomputed: Number(d.recomputed),
    };
  });
  const totalDeductions =
    deviations.length > 0
      ? Math.round((snapshot.result.grossPay - net) * 100) / 100
      : snapshot.result.totalDeductions;
  return { federalWithholding: federal, totalDeductions, netPay: net, deviations };
}

export interface ChangeRequest {
  publicId: string;
  employeeId: number;
  employeeName?: string;
  requestType: ChangeRequestType;
  payload: Record<string, unknown>;
  effectiveFrom: string;
  status: RequestStatus;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface ChangeRequestComment {
  id: number;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

export interface MyProfile {
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  status: string;
  address: Address | null;
  bankDetails: {
    type: string | null;
    routingMasked: string | null;
    accountMasked: string | null;
  } | null;
  taxIdMasked: string | null;
  w4: {
    taxYear: number;
    filingStatus: string;
    federalExempt: boolean;
    dependentsAmount: string;
    otherIncome: string;
    deductionsAmount: string;
    extraWithholding: string;
    effectiveFrom: string;
  } | null;
}

export interface NotificationSetting {
  eventType: string;
  enabled: boolean;
}

export interface PayrollRunRow {
  publicId: string;
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: RunStatus;
  snapshotHash: string | null;
  createdBy: string;
  createdAt: string | null;
  runSnapshot?: RunSnapshot;
  approvedBy?: string | null;
  approvedAt?: string | null;
  issuedAt?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
}

export interface PaySchedule {
  id: number;
  employeeId: number | null;
  frequency: string;
  draftDayOfMonth: number;
  payDayOfMonth: number;
  autoDraft: boolean;
  active: boolean;
}

export interface CompensationRow {
  id: number;
  employeeId: number;
  periodAmount: string;
  frequency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface W4ElectionRow {
  id: number;
  employeeId: number;
  taxYear: number;
  filingStatus: string;
  federalExempt: boolean;
  multipleJobs: boolean;
  dependentsAmount: string;
  otherIncome: string;
  deductionsAmount: string;
  extraWithholding: string;
  effectiveFrom: string;
  filedDate: string;
  renewalDeadline: string | null;
  note: string | null;
}

export interface TaxConfigRow {
  id: number;
  jurisdiction: string;
  taxYear: number;
  standardDeduction: string;
  socialSecurityRate: string;
  socialSecurityWageCap: string;
  medicareRate: string;
  medicareAdditionalRate: string;
  medicareAdditionalThreshold: string;
  stateWithholdingRate: string;
  employerSocialSecurityRate: string;
  employerMedicareRate: string;
  futaRate: string;
  futaWageCap: string;
}

export interface TaxBracketRow {
  id: number;
  jurisdiction: string;
  taxYear: number;
  ordinal: number;
  minAmount: string;
  maxAmount: string | null;
  rate: string;
}

export interface AdminEmployeeListRow {
  id: number;
  userId: string | null;
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  terminationDate: string | null;
  status: string;
  userEmail: string | null;
  userBanned: boolean | null;
}

export interface AdminEmployeeDetail {
  id: number;
  userId: string | null;
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  terminationDate: string | null;
  status: string;
  address: Address | null;
  dateOfBirth: string | null;
  /** Presence flag only (spec 11) — the TIN itself never reaches the browser. */
  hasTaxId: boolean;
  user: {
    id: string;
    email: string | null;
    banned: boolean | null;
    banReason: string | null;
  } | null;
}

export interface InviteResult {
  userId: string;
  email: string;
  setupLink: string;
  smtpMissing: boolean;
  resent?: boolean;
}

export interface OutboxHealth {
  counts: Record<string, number>;
  recentFailures: {
    id: number;
    userId: string;
    eventType: string;
    subject: string;
    attempts: number;
    lastError: string | null;
    lastAttemptAt: string | null;
    createdAt: string | null;
  }[];
  emailMode: "smtp" | "log";
  smtp: {
    configured: boolean;
    host: string | null;
    port: number;
    from: string | null;
    secure: boolean;
  };
}

export interface CompanyProfile {
  id: number;
  legalName: string;
  einMasked: string | null;
  address: Address | null;
}

export interface AuthEventRow {
  id: number;
  userId: string | null;
  event: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string | null;
}

export interface AuditEventRow {
  id: number;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string | null;
}

export interface Paged<T> {
  events: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------

import { notifySessionExpired } from "./session-expired";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    // PAY-6: a 401 on a session-gated endpoint means the session expired
    // (idle 12h / absolute 7d, or revoked) — redirect to login instead of
    // letting every in-flight call toast an error. Onboarding endpoints are
    // token-based (no session), so their 401s stay local.
    if (res.status === 401 && !path.startsWith("/api/onboarding/")) {
      notifySessionExpired();
    }
    let code = "request_failed";
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const data = (await res.json()) as { error?: string; message?: string; details?: unknown };
      if (data.error) code = data.error;
      if (data.message) message = data.message;
      details = data.details;
    } catch {
      // non-JSON error body — keep defaults
    }
    throw new ApiError(res.status, code, message, details);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Endpoint namespaces
// ---------------------------------------------------------------------------

export const onboardingApi = {
  verifyToken: (token: string) =>
    post<{ email: string; name: string; purpose: string }>("/api/onboarding/verify-token", {
      token,
    }),
  setPassword: (token: string, password: string) =>
    post<{ ok: true; next: string }>("/api/onboarding/set-password", { token, password }),
  totpEnable: (token: string) =>
    post<{ totpURI: string }>("/api/onboarding/totp-enable", { token }),
  totpVerify: (token: string, code: string) =>
    post<{ ok: true; backupCodes: string[] }>("/api/onboarding/totp-verify", { token, code }),
};

export const payslipsApi = {
  list: () => get<{ payslips: PayslipSummary[] }>("/api/payslips"),
  detail: (publicId: string) => get<{ payslip: PayslipDetail }>(`/api/payslips/${publicId}`),
  pdfUrl: (publicId: string) => `/api/payslips/${publicId}/pdf`,
};

export const myInvoicesApi = {
  list: () => get<{ invoices: MyInvoice[] }>("/api/my/invoices"),
  pdfUrl: (id: number) => `/api/my/invoices/${id}/pdf`,
};

export const changeRequestsApi = {
  submit: (input: {
    requestType: ChangeRequestType;
    payload: Record<string, unknown>;
    effectiveFrom: string;
  }) => post<{ request: ChangeRequest }>("/api/change-requests", input),
  list: (filter: { status?: RequestStatus; requestType?: ChangeRequestType } = {}) =>
    get<{ requests: ChangeRequest[] }>(`/api/change-requests${qs(filter)}`),
  detail: (publicId: string) =>
    get<{ request: ChangeRequest; comments: ChangeRequestComment[] }>(
      `/api/change-requests/${publicId}`,
    ),
  comment: (publicId: string, body: string) =>
    post<{ ok: true }>(`/api/change-requests/${publicId}/comments`, { body }),
  approve: (publicId: string, input: { note?: string; effectiveFromOverride?: string } = {}) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/approve`, input),
  deny: (publicId: string, reason: string) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/deny`, { reason }),
  withdraw: (publicId: string) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/withdraw`),
  /** Admin-only reveal-on-demand for tax_id requests (spec 11 D21; audit-logged). */
  revealTaxId: (publicId: string) =>
    get<{ taxId: string }>(`/api/change-requests/${publicId}/reveal-tax-id`),
};

export const myApi = {
  profile: () => get<{ profile: MyProfile }>("/api/my/profile"),
  security: () =>
    get<{ twoFactorEnabled: boolean; backupCodesRemaining: number }>("/api/my/security"),
  regenerateBackupCodes: () => post<{ backupCodes: string[] }>("/api/my/backup-codes"),
  notificationSettings: () =>
    get<{ settings: NotificationSetting[] }>("/api/my/notification-settings"),
  putNotificationSettings: (settings: NotificationSetting[]) =>
    put<{ ok: true }>("/api/my/notification-settings", { settings }),
};

export const adminPayrollApi = {
  runs: (filter: { status?: RunStatus; employeeId?: number; year?: number } = {}) =>
    get<{ runs: PayrollRunRow[] }>(`/api/admin/payroll-runs${qs(filter)}`),
  run: (publicId: string) => get<{ run: PayrollRunRow }>(`/api/admin/payroll-runs/${publicId}`),
  generate: (input: { year: number; month: number; employeeId?: number }) =>
    post<{ generated: PayrollRunRow[]; skipped: { employeeId: number; reason: string }[] }>(
      "/api/admin/payroll-runs/generate",
      input,
    ),
  act: (publicId: string, action: "approve" | "issue" | "void", reason?: string) =>
    post<{ run: PayrollRunRow }>(
      `/api/admin/payroll-runs/${publicId}/${action}`,
      reason ? { reason } : {},
    ),
  schedules: () => get<{ schedules: PaySchedule[] }>("/api/admin/pay-schedules"),
  putSchedule: (input: {
    draftDayOfMonth: number;
    payDayOfMonth: number;
    autoDraft: boolean;
    active: boolean;
  }) => put<{ schedule: PaySchedule }>("/api/admin/pay-schedules", input),
  compensation: (employeeId: number) =>
    get<{ compensation: CompensationRow[] }>(`/api/admin/employees/${employeeId}/compensation`),
  addCompensation: (
    employeeId: number,
    input: {
      periodAmount: number;
      frequency: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
  ) =>
    post<{ compensation: CompensationRow }>(
      `/api/admin/employees/${employeeId}/compensation`,
      input,
    ),
  w4: (employeeId: number) =>
    get<{ w4Elections: W4ElectionRow[] }>(`/api/admin/employees/${employeeId}/w4`),
  addW4: (employeeId: number, input: Record<string, unknown>) =>
    post<{ w4: W4ElectionRow }>(`/api/admin/employees/${employeeId}/w4`, input),
  taxConfig: (filter: { year?: number; jurisdiction?: string } = {}) =>
    get<{ taxConfig: TaxConfigRow[]; taxBrackets: TaxBracketRow[] }>(
      `/api/admin/tax-config${qs(filter)}`,
    ),
  putTaxConfig: (input: {
    jurisdiction: string;
    taxYear: number;
    config: Record<string, number>;
    brackets: { ordinal: number; minAmount: number; maxAmount: number | null; rate: number }[];
  }) => put<{ ok: true }>("/api/admin/tax-config", input),
};

export const adminEmployeesApi = {
  list: () => get<{ employees: AdminEmployeeListRow[] }>("/api/admin/employees"),
  detail: (employeeId: number) =>
    get<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}`),
  create: (input: {
    legalName: string;
    preferredName?: string;
    employmentType: string;
    hireDate: string;
    address?: Address;
    taxId?: string;
  }) => post<{ employee: AdminEmployeeDetail }>("/api/admin/employees", input),
  invite: (employeeId: number, input: { email?: string; name?: string } = {}) =>
    post<InviteResult>(`/api/admin/employees/${employeeId}/invite`, input),
  setStatus: (
    employeeId: number,
    input: { status: "active" | "terminated"; terminationDate?: string },
  ) => post<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}/status`, input),
  /** Spec 11 (D20a): admin direct-set of the employee TIN (write-only). */
  setTaxId: (employeeId: number, input: { taxId: string }) =>
    patch<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}`, input),
};

export const adminUsersApi = {
  invite: (input: { name: string; email: string; role: "admin" | "employee" }) =>
    post<InviteResult>("/api/admin/users", input),
  reset: (userId: string) => post<InviteResult>(`/api/admin/users/${userId}/reset`),
  unlock: (userId: string) => post<{ ok: true }>(`/api/admin/users/${userId}/unlock`),
};

export const adminNotificationsApi = {
  outbox: () => get<OutboxHealth>("/api/admin/notifications/outbox"),
  testEmail: () => post<{ ok: true; queued: boolean }>("/api/admin/settings/test-email"),
};

export const adminSettingsApi = {
  company: () => get<{ company: CompanyProfile }>("/api/admin/company"),
  putCompany: (input: { legalName: string; address?: Address; ein?: string }) =>
    put<{ company: CompanyProfile }>("/api/admin/company", input),
  authEvents: (input: { limit?: number; offset?: number } = {}) =>
    get<Paged<AuthEventRow>>(`/api/admin/audit/auth-events${qs(input)}`),
  auditEvents: (input: { limit?: number; offset?: number } = {}) =>
    get<Paged<AuditEventRow>>(`/api/admin/audit/audit-events${qs(input)}`),
};

// ---------------------------------------------------------------------------
// Spec 10 — contractors
// ---------------------------------------------------------------------------

export type TaxStatus = "us_person" | "nonresident";
export type ContractorEntityType = "individual" | "entity";
export type TaxForm = "w9" | "w8ben" | "w8ben_e" | "w8eci";
export type ServicesLocation = "foreign" | "us" | "mixed";
export type PaymentMethod = "ach" | "check" | "wire" | "card" | "third_party_network";
export type InvoiceStatus = "submitted" | "approved" | "rejected" | "paid" | "void";

export interface UsDayEntry {
  year: number;
  days: number;
  note?: string;
}

export interface ContractorListRow {
  employeeId: number;
  legalName: string;
  preferredName: string | null;
  hireDate: string;
  status: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  residenceCountry: string | null;
  taxForm: TaxForm;
  formCollectedAt: string | null;
  formExpiresAt: string | null;
  backupWithholding: boolean;
  servicesLocation: ServicesLocation;
}

export interface ContractorDetails extends ContractorListRow {
  usDaysLog: UsDayEntry[];
  tinMasked: string | null;
}

export interface ContractorPaymentRow {
  id: number;
  invoiceId: number;
  payDate: string;
  amount: string;
  exchangeRate: string | null;
  method: PaymentMethod;
  backupWithheld: string;
  reference: string | null;
  createdAt: string | null;
}

export interface ContractorInvoiceRow {
  id: number;
  employeeId: number;
  invoiceRef: string | null;
  description: string;
  amount: string;
  currency: string;
  invoiceDate: string;
  status: InvoiceStatus;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Spec 12: set when generated by a recurring template; NULL = manual. */
  recurringTemplateId: number | null;
  recurringPeriod: string | null;
  createdAt: string | null;
  payment: ContractorPaymentRow | null;
}

export interface ContractorDetail {
  contractor: {
    id: number;
    userId: string | null;
    legalName: string;
    preferredName: string | null;
    hireDate: string;
    status: string;
    details: {
      taxStatus: TaxStatus;
      entityType: ContractorEntityType;
      residenceCountry: string | null;
      taxForm: TaxForm;
      formCollectedAt: string | null;
      formExpiresAt: string | null;
      backupWithholding: boolean;
      servicesLocation: ServicesLocation;
      usDaysLog: UsDayEntry[];
      tinMasked: string | null;
    };
  };
  invoices: ContractorInvoiceRow[];
}

export interface YearEndRow {
  employeeId: number;
  legalName: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  taxForm: TaxForm;
  formCollectedAt: string | null;
  formExpiresAt: string | null;
  formExpired: boolean;
  servicesLocation: ServicesLocation;
  review1042: boolean;
  payments: {
    payDate: string;
    amount: string;
    method: string;
    backupWithheld: string;
    reference: string | null;
  }[];
  reportableTotal: number;
  grossTotal: number;
  backupWithheldTotal: number;
  threshold: number;
  formRequired: boolean;
}

export interface ReportingConfigRow {
  id: number;
  taxYear: number;
  necThreshold: string;
  note: string;
}

export interface ContractorCreateInput {
  legalName: string;
  preferredName?: string;
  hireDate: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  residenceCountry?: string;
  tin?: string;
  taxForm: TaxForm;
  formCollectedAt?: string;
  backupWithholding?: boolean;
  servicesLocation?: ServicesLocation;
  usDaysLog?: UsDayEntry[];
}

/** Update payload — nullable fields clear the stored value server-side. */
export interface ContractorUpdateInput {
  legalName?: string;
  preferredName?: string | null;
  taxStatus?: TaxStatus;
  entityType?: ContractorEntityType;
  residenceCountry?: string | null;
  tin?: string | null;
  taxForm?: TaxForm;
  formCollectedAt?: string | null;
  backupWithholding?: boolean;
  servicesLocation?: ServicesLocation;
  usDaysLog?: UsDayEntry[];
}

// ---------------------------------------------------------------------------
// Spec 12 — recurring contractor invoices
// ---------------------------------------------------------------------------

export type InvoiceDay = "last_day" | "fixed";

export interface RecurringTemplateRow {
  id: number;
  employeeId: number;
  description: string;
  amount: string;
  currency: string;
  invoiceDay: InvoiceDay;
  invoiceDayOfMonth: number | null;
  payDayOfMonth: number;
  active: boolean;
  startsOn: string;
  endsOn: string | null;
  lastGeneratedPeriod: string | null;
  /** Server-computed next invoice date; null when paused/ended/exhausted. */
  nextGenerationOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RecurringTemplateInput {
  description: string;
  amount: number;
  invoiceDay: InvoiceDay;
  invoiceDayOfMonth?: number | null;
  payDayOfMonth: number;
  startsOn: string;
  endsOn?: string | null;
}

/** Edits affect future generations only (D25); active toggles pause/resume. */
export type RecurringTemplatePatch = Partial<RecurringTemplateInput> & { active?: boolean };

export const adminContractorsApi = {
  list: () => get<{ contractors: ContractorListRow[] }>("/api/admin/contractors"),
  create: (input: ContractorCreateInput) =>
    post<{ employeeId: number }>("/api/admin/contractors", input),
  detail: (employeeId: number) => get<ContractorDetail>(`/api/admin/contractors/${employeeId}`),
  update: (employeeId: number, input: ContractorUpdateInput) =>
    request<{ ok: true }>("PATCH", `/api/admin/contractors/${employeeId}`, input),
  addInvoice: (
    employeeId: number,
    input: { invoiceRef?: string; description: string; amount: number; invoiceDate: string },
  ) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/contractors/${employeeId}/invoices`, input),
  approve: (invoiceId: number, note?: string) =>
    post<{ invoice: ContractorInvoiceRow }>(
      `/api/admin/invoices/${invoiceId}/approve`,
      note ? { note } : {},
    ),
  reject: (invoiceId: number, note: string) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/invoices/${invoiceId}/reject`, { note }),
  pay: (
    invoiceId: number,
    input: {
      payDate: string;
      amount: number;
      exchangeRate?: number | null;
      method: PaymentMethod;
      reference?: string;
    },
  ) =>
    post<{ invoice: ContractorInvoiceRow; payment: ContractorPaymentRow }>(
      `/api/admin/invoices/${invoiceId}/pay`,
      input,
    ),
  void: (invoiceId: number, note: string) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/invoices/${invoiceId}/void`, { note }),
  yearEnd: (year: number) =>
    get<{ taxYear: number; threshold: string; rows: YearEndRow[] }>(
      `/api/admin/contractors/year-end${qs({ year })}`,
    ),
  nec1099Url: (employeeId: number, year: number) =>
    `/api/admin/contractors/${employeeId}/1099-nec?year=${year}`,
  reportingConfig: () =>
    get<{ config: ReportingConfigRow[] }>("/api/admin/contractor-reporting-config"),
  putReportingConfig: (input: { taxYear: number; necThreshold: number; note?: string }) =>
    put<{ config: ReportingConfigRow }>("/api/admin/contractor-reporting-config", input),
  // Spec 12 — recurring invoice templates
  recurringList: (employeeId: number) =>
    get<{ templates: RecurringTemplateRow[] }>(`/api/admin/contractors/${employeeId}/recurring`),
  recurringCreate: (employeeId: number, input: RecurringTemplateInput) =>
    post<{ template: RecurringTemplateRow }>(
      `/api/admin/contractors/${employeeId}/recurring`,
      input,
    ),
  recurringUpdate: (templateId: number, input: RecurringTemplatePatch) =>
    patch<{ template: RecurringTemplateRow }>(`/api/admin/recurring/${templateId}`, input),
  recurringDelete: (templateId: number) =>
    request<{ ok: true }>("DELETE", `/api/admin/recurring/${templateId}`),
};

// ---------------------------------------------------------------------------
// PAY-9 — monthly federal tax deposits (admin, record-only)
// ---------------------------------------------------------------------------

export type TaxDepositStatus = "pending" | "deposited" | "overdue";

export interface TaxDepositRow {
  id: number;
  jurisdiction: string;
  /** First of the deposit month ("2026-08-01" = the August deposit). */
  periodStart: string;
  amount: string;
  dueDate: string;
  status: TaxDepositStatus;
  depositedOn: string | null;
  eftpsConfirmation: string | null;
  remindersSent: number[];
  createdAt: string | null;
  updatedAt: string | null;
}

export const adminDepositsApi = {
  list: () => get<{ deposits: TaxDepositRow[] }>("/api/admin/tax-deposits"),
  markDeposited: (id: number, input: { depositedOn: string; eftpsConfirmation: string }) =>
    post<{ deposit: TaxDepositRow }>(`/api/admin/tax-deposits/${id}/deposit`, input),
  reminderSchedule: () =>
    get<{ offsets: number[]; defaultOffsets: number[] }>(
      "/api/admin/tax-deposits/reminder-schedule",
    ),
  putReminderSchedule: (offsets: number[]) =>
    put<{ offsets: number[] }>("/api/admin/tax-deposits/reminder-schedule", { offsets }),
};
