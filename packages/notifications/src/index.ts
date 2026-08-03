/**
 * Email templates (spec notifications): one function per catalog event, each
 * returning {subject, html, text} (text/plain fallback always present).
 * MJML-free, branding = company name from the company row, no external assets.
 *
 * CONTENT RULES (spec — enforced here, asserted in tests):
 * - change_request_* emails never include amounts.
 * - payslip_issued states the period + "log in to view/download" — never net
 *   pay, never attachments.
 * - bank/SSN data never appears in ANY email.
 */

export const EVENT_TYPE = {
  payrollDraftReady: "payroll_draft_ready",
  payslipIssued: "payslip_issued",
  changeRequestSubmitted: "change_request_submitted",
  changeRequestApproved: "change_request_approved",
  changeRequestDenied: "change_request_denied",
  securityInvite: "security_invite",
  securityPasswordReset: "security_password_reset",
  securityLoginNewDevice: "security_login_new_device",
  /** Admin observability test email (spec admin settings page). */
  adminTestEmail: "admin_test_email",
  /** Spec 10 — contractor invoice workflow + W-8 form lifecycle. */
  contractorInvoiceSubmitted: "contractor_invoice_submitted",
  contractorInvoiceReviewed: "contractor_invoice_reviewed",
  contractorInvoicePaid: "contractor_invoice_paid",
  contractorFormExpiring: "contractor_form_expiring",
  contractorFormExpired: "contractor_form_expired",
  /** Spec 12 — recurring invoice generation + payment-due reminder. */
  contractorRecurringGenerated: "contractor_recurring_generated",
  contractorRecurringPaymentDue: "contractor_recurring_payment_due",
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

/** Toggleable workflow events (the five in settings UI); security + admin events are always on. */
export const WORKFLOW_EVENTS: readonly EventType[] = [
  EVENT_TYPE.payrollDraftReady,
  EVENT_TYPE.payslipIssued,
  EVENT_TYPE.changeRequestSubmitted,
  EVENT_TYPE.changeRequestApproved,
  EVENT_TYPE.changeRequestDenied,
];

/**
 * Spec 10 contractor events — compliance notices to admins (form expiry,
 * payment gate) and contractor-facing invoice lifecycle mail. Always on: not
 * part of the five toggleable workflow events (the settings surface is
 * unchanged from spec 6).
 */
export const CONTRACTOR_EVENTS: readonly EventType[] = [
  EVENT_TYPE.contractorInvoiceSubmitted,
  EVENT_TYPE.contractorInvoiceReviewed,
  EVENT_TYPE.contractorInvoicePaid,
  EVENT_TYPE.contractorFormExpiring,
  EVENT_TYPE.contractorFormExpired,
  EVENT_TYPE.contractorRecurringGenerated,
  EVENT_TYPE.contractorRecurringPaymentDue,
];

export const SECURITY_EVENTS: readonly EventType[] = [
  EVENT_TYPE.securityInvite,
  EVENT_TYPE.securityPasswordReset,
  EVENT_TYPE.securityLoginNewDevice,
  EVENT_TYPE.adminTestEmail,
];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateContext {
  companyName: string;
  /** Public app URL for "log in" links (no deep links to sensitive data). */
  appUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(ctx: TemplateContext, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">${escapeHtml(ctx.companyName)}</h2>
${bodyHtml}
<p style="color:#777;font-size:12px;margin-top:32px">This is an automated message from ${escapeHtml(ctx.companyName)} Payroll. Do not reply.</p>
</body></html>`;
}

function email(
  ctx: TemplateContext,
  subject: string,
  bodyHtml: string,
  text: string,
): RenderedEmail {
  return { subject: `${ctx.companyName} Payroll — ${subject}`, html: page(ctx, bodyHtml), text };
}

const CHANGE_REQUEST_LABELS: Record<string, string> = {
  address: "address",
  w4: "withholding (W-4) election",
  bank_details: "bank details",
  legal_name: "legal name",
  tax_id: "tax ID",
};

export function crLabel(requestType: string): string {
  return CHANGE_REQUEST_LABELS[requestType] ?? requestType;
}

// ---------------------------------------------------------------------------
// Workflow events
// ---------------------------------------------------------------------------

export function payrollDraftReady(
  ctx: TemplateContext,
  data: { employeeName: string; periodStart: string; periodEnd: string; payDate: string },
): RenderedEmail {
  const body = `<p>A payroll draft for <strong>${escapeHtml(data.employeeName)}</strong> (period ${data.periodStart} → ${data.periodEnd}, pay date ${data.payDate}) awaits your review.</p><p><a href="${ctx.appUrl}">Log in to review and approve</a>.</p>`;
  return email(
    ctx,
    "payroll draft ready",
    body,
    `A payroll draft for ${data.employeeName} (period ${data.periodStart} to ${data.periodEnd}, pay date ${data.payDate}) awaits your review. Log in to approve: ${ctx.appUrl}`,
  );
}

export function payslipIssued(
  ctx: TemplateContext,
  data: { periodLabel: string; payDate: string },
): RenderedEmail {
  // Spec: period + "log in to view/download" — NEVER net pay, NEVER attachments.
  const body = `<p>Your payslip for <strong>${escapeHtml(data.periodLabel)}</strong> (pay date ${data.payDate}) has been issued.</p><p><a href="${ctx.appUrl}">Log in to view and download it</a>.</p>`;
  return email(
    ctx,
    "payslip issued",
    body,
    `Your payslip for ${data.periodLabel} (pay date ${data.payDate}) has been issued. Log in to view and download it: ${ctx.appUrl}`,
  );
}

export function changeRequestSubmitted(
  ctx: TemplateContext,
  data: { employeeName: string; requestType: string },
): RenderedEmail {
  // Spec: never amounts — type + employee only.
  const label = crLabel(data.requestType);
  const body = `<p><strong>${escapeHtml(data.employeeName)}</strong> submitted a change request for their <strong>${label}</strong>.</p><p><a href="${ctx.appUrl}">Log in to review the request</a>.</p>`;
  return email(
    ctx,
    "change request submitted",
    body,
    `${data.employeeName} submitted a change request for their ${label}. Log in to review: ${ctx.appUrl}`,
  );
}

export function changeRequestApproved(
  ctx: TemplateContext,
  data: { requestType: string; effectiveFrom: string },
): RenderedEmail {
  const label = crLabel(data.requestType);
  const body = `<p>Your change request for your <strong>${label}</strong> was approved, effective ${data.effectiveFrom}.</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  return email(
    ctx,
    "change request approved",
    body,
    `Your change request for your ${label} was approved, effective ${data.effectiveFrom}. Log in to view details: ${ctx.appUrl}`,
  );
}

export function changeRequestDenied(
  ctx: TemplateContext,
  data: { requestType: string },
): RenderedEmail {
  const label = crLabel(data.requestType);
  const body = `<p>Your change request for your <strong>${label}</strong> was denied.</p><p><a href="${ctx.appUrl}">Log in to view the reason and thread</a>.</p>`;
  return email(
    ctx,
    "change request denied",
    body,
    `Your change request for your ${label} was denied. Log in to view the reason: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// Security events (always on)
// ---------------------------------------------------------------------------

export function securityInvite(ctx: TemplateContext, data: { setupLink: string }): RenderedEmail {
  const body = `<p>You have been invited to ${escapeHtml(ctx.companyName)} Payroll.</p><p><a href="${data.setupLink}">Set up your account</a> (single-use link, valid 24 hours). You will choose a password and enroll an authenticator app.</p>`;
  return email(
    ctx,
    "you're invited",
    body,
    `You have been invited to ${ctx.companyName} Payroll. Set up your account with this single-use link (valid 24 hours): ${data.setupLink}`,
  );
}

export function securityPasswordReset(
  ctx: TemplateContext,
  data: { setupLink: string },
): RenderedEmail {
  const body = `<p>A password reset was requested for your ${escapeHtml(ctx.companyName)} Payroll account. You will need to set a new password and re-enroll your authenticator app.</p><p><a href="${data.setupLink}">Reset your password</a> (single-use link, valid 24 hours). If you did not request this, contact your administrator.</p>`;
  return email(
    ctx,
    "password reset",
    body,
    `A password reset was requested for your ${ctx.companyName} Payroll account. Reset with this single-use link (valid 24 hours): ${data.setupLink}`,
  );
}

export function securityLoginNewDevice(
  ctx: TemplateContext,
  data: { userAgent: string | null; ip: string | null; at: string },
): RenderedEmail {
  const ua = data.userAgent ?? "unknown device";
  const ip = data.ip ?? "unknown IP";
  const body = `<p>A sign-in to your ${escapeHtml(ctx.companyName)} Payroll account completed from a device we have not seen before:</p><ul><li>Device: ${escapeHtml(ua)}</li><li>IP: ${escapeHtml(ip)}</li><li>Time: ${escapeHtml(data.at)}</li></ul><p>If this was not you, contact your administrator immediately.</p>`;
  return email(
    ctx,
    "new device sign-in",
    body,
    `A sign-in to your ${ctx.companyName} Payroll account completed from an unseen device (${ua}, IP ${ip}, at ${data.at}). If this was not you, contact your administrator immediately.`,
  );
}

export function adminTestEmail(ctx: TemplateContext, data: { by: string }): RenderedEmail {
  const body = `<p>This is a test email from the ${escapeHtml(ctx.companyName)} Payroll admin settings, requested by ${escapeHtml(data.by)}. SMTP delivery is working.</p>`;
  return email(
    ctx,
    "test email",
    body,
    `Test email from ${ctx.companyName} Payroll admin settings (requested by ${data.by}). SMTP delivery is working.`,
  );
}

// ---------------------------------------------------------------------------
// Spec 10 — contractor invoice workflow + W-8 form lifecycle
// ---------------------------------------------------------------------------

const TAX_FORM_LABELS: Record<string, string> = {
  w9: "W-9",
  w8ben: "W-8BEN",
  w8ben_e: "W-8BEN-E",
  w8eci: "W-8ECI",
};

export function taxFormLabel(taxForm: string): string {
  return TAX_FORM_LABELS[taxForm] ?? taxForm.toUpperCase();
}

/** Admin: a contractor self-submitted an invoice (D16 portal; V1 invoices are admin-entered). */
export function contractorInvoiceSubmitted(
  ctx: TemplateContext,
  data: { contractorName: string; description: string },
): RenderedEmail {
  const body = `<p><strong>${escapeHtml(data.contractorName)}</strong> submitted an invoice: ${escapeHtml(data.description)}.</p><p><a href="${ctx.appUrl}">Log in to review it</a>.</p>`;
  return email(
    ctx,
    "contractor invoice submitted",
    body,
    `${data.contractorName} submitted an invoice (${data.description}). Log in to review it: ${ctx.appUrl}`,
  );
}

/** Contractor: their invoice was approved or rejected (no amounts). */
export function contractorInvoiceReviewed(
  ctx: TemplateContext,
  data: { description: string; approved: boolean; note: string | null },
): RenderedEmail {
  const decision = data.approved ? "approved" : "rejected";
  const notePart = data.note ? ` Note: ${escapeHtml(data.note)}` : "";
  const body = `<p>Your invoice (${escapeHtml(data.description)}) was <strong>${decision}</strong>.${notePart}</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  const textNote = data.note ? ` Note: ${data.note}` : "";
  return email(
    ctx,
    `invoice ${decision}`,
    body,
    `Your invoice (${data.description}) was ${decision}.${textNote} Log in to view details: ${ctx.appUrl}`,
  );
}

/** Contractor: payment recorded against their invoice. */
export function contractorInvoicePaid(
  ctx: TemplateContext,
  data: { description: string; payDate: string },
): RenderedEmail {
  const body = `<p>Payment for your invoice (${escapeHtml(data.description)}) was recorded, pay date ${data.payDate}.</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  return email(
    ctx,
    "invoice paid",
    body,
    `Payment for your invoice (${data.description}) was recorded, pay date ${data.payDate}. Log in to view details: ${ctx.appUrl}`,
  );
}

/** Admin: a contractor's W-8 expires within 30 days — collect a renewal before the payment gate re-arms. */
export function contractorFormExpiring(
  ctx: TemplateContext,
  data: { contractorName: string; taxForm: string; expiresAt: string; daysLeft: number },
): RenderedEmail {
  const form = taxFormLabel(data.taxForm);
  const body = `<p>The <strong>${form}</strong> on file for <strong>${escapeHtml(data.contractorName)}</strong> expires on ${data.expiresAt} (${data.daysLeft} days). Collect a renewal — payments are blocked once the form expires.</p><p><a href="${ctx.appUrl}">Log in to update the record</a>.</p>`;
  return email(
    ctx,
    `contractor ${form} expiring`,
    body,
    `The ${form} on file for ${data.contractorName} expires on ${data.expiresAt} (${data.daysLeft} days). Collect a renewal — payments are blocked once the form expires: ${ctx.appUrl}`,
  );
}

/** Admin: a contractor's form expired — the payment gate has re-armed. */
export function contractorFormExpired(
  ctx: TemplateContext,
  data: { contractorName: string; taxForm: string; expiresAt: string },
): RenderedEmail {
  const form = taxFormLabel(data.taxForm);
  const body = `<p>The <strong>${form}</strong> on file for <strong>${escapeHtml(data.contractorName)}</strong> expired on ${data.expiresAt}. Payments are blocked until a new form is collected.</p><p><a href="${ctx.appUrl}">Log in to update the record</a>.</p>`;
  return email(
    ctx,
    `contractor ${form} expired`,
    body,
    `The ${form} on file for ${data.contractorName} expired on ${data.expiresAt}. Payments are blocked until a new form is collected: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// Spec 12 — recurring contractor invoices
// ---------------------------------------------------------------------------

/** Admin: the recurring scheduler generated an invoice — it awaits approval (spec 12 §2). */
export function contractorRecurringGenerated(
  ctx: TemplateContext,
  data: { contractorName: string; amountLabel: string; periodLabel: string; description: string },
): RenderedEmail {
  const body = `<p>Recurring invoice for <strong>${escapeHtml(data.contractorName)}</strong> — ${escapeHtml(data.amountLabel)}, ${data.periodLabel} — was generated and is awaiting your approval (${escapeHtml(data.description)}).</p><p><a href="${ctx.appUrl}">Log in to review it</a>.</p>`;
  return email(
    ctx,
    "recurring invoice awaiting approval",
    body,
    `Recurring invoice for ${data.contractorName} — ${data.amountLabel}, ${data.periodLabel} — was generated and is awaiting your approval (${data.description}). Log in to review it: ${ctx.appUrl}`,
  );
}

/** Admin: pay day arrived and the generated invoice is approved but unpaid (spec 12 §3). */
export function contractorRecurringPaymentDue(
  ctx: TemplateContext,
  data: { contractorName: string; amountLabel: string; description: string },
): RenderedEmail {
  const body = `<p>Payment due today: <strong>${escapeHtml(data.contractorName)}</strong> — ${escapeHtml(data.amountLabel)} (${escapeHtml(data.description)}). The invoice is approved but no payment is recorded.</p><p><a href="${ctx.appUrl}">Log in to record the payment</a>.</p>`;
  return email(
    ctx,
    "contractor payment due today",
    body,
    `Payment due today: ${data.contractorName} — ${data.amountLabel} (${data.description}). The invoice is approved but no payment is recorded. Log in to record the payment: ${ctx.appUrl}`,
  );
}
