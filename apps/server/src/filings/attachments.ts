/**
 * Filing attachments (PAY-24) — external confirmation/evidence documents
 * uploaded to a tax filing: the SSA BSO receipt PDF for a W-2/W-3
 * submission, an IRS e-file acknowledgment, the Letterstream proof for a
 * mailed 941/940.
 *
 * These are external record documents, so the "data is truth, PDFs on
 * demand" doctrine does not apply — the uploaded file is stored as-is.
 * Because confirmations can carry the EIN, the bytes are AES-256-GCM
 * encrypted at rest (encryptBytes/decryptBytes, same SECRETS_DIR key as
 * tax_id/bank_details); decryption happens only when an authorized admin
 * downloads the file. Upload and download are audit-logged.
 */

import { and, asc, eq } from "drizzle-orm";
import { auditEvents, filingAttachments, taxFilings } from "@payroll/db";
import type { Db } from "../db.js";
import { decryptBytes, encryptBytes } from "../crypto/field-encryption.js";
import { type Deps, FilingServiceError } from "./shared.js";

/** PDFs only — confirmed by magic bytes, not the declared content type. */
export const PDF_MAGIC = Buffer.from("%PDF-");
/** 5 MB — a BSO receipt / e-file acknowledgment is a small document. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FilingAttachmentMeta {
  id: number;
  filingId: number;
  filename: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date | null;
}

const META_COLUMNS = {
  id: filingAttachments.id,
  filingId: filingAttachments.filingId,
  filename: filingAttachments.filename,
  sizeBytes: filingAttachments.sizeBytes,
  uploadedBy: filingAttachments.uploadedBy,
  createdAt: filingAttachments.createdAt,
} as const;

/** Strip path components / control chars from a client-supplied name. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replaceAll(/[^\w.() -]/g, "_").trim();
  return cleaned.slice(0, 200) || "confirmation.pdf";
}

async function filingExists(db: Db, filingId: number): Promise<void> {
  const rows = await db
    .select({ id: taxFilings.id })
    .from(taxFilings)
    .where(eq(taxFilings.id, filingId))
    .limit(1);
  if (!rows[0]) throw new FilingServiceError("not_found", `tax filing ${filingId} not found`);
}

export async function listFilingAttachments(
  db: Db,
  filingId: number,
): Promise<FilingAttachmentMeta[]> {
  await filingExists(db, filingId);
  return db
    .select(META_COLUMNS)
    .from(filingAttachments)
    .where(eq(filingAttachments.filingId, filingId))
    .orderBy(asc(filingAttachments.id));
}

/**
 * Store an upload (PDF only, magic-byte verified, size-capped). The audit
 * row lands in the same transaction as the insert.
 */
export async function addFilingAttachment(
  deps: Deps,
  filingId: number,
  input: { filename: string; data: Buffer },
  actorId: string,
): Promise<FilingAttachmentMeta> {
  const { db, config } = deps;
  await filingExists(db, filingId);
  const { data } = input;
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
    throw new FilingServiceError(
      "invalid_input",
      `attachment must be 1 byte – ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  }
  if (!data.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new FilingServiceError("invalid_input", "attachment must be a PDF (%PDF magic bytes)");
  }
  const filename = sanitizeFilename(input.filename);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(filingAttachments)
      .values({
        filingId,
        filename,
        sizeBytes: data.length,
        data: encryptBytes(data, config.encryptionKey),
        uploadedBy: actorId,
      })
      .returning(META_COLUMNS);
    const row = inserted[0];
    if (!row) throw new Error("filing attachment insert failed");
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_filing.attach",
      entity: "tax_filing",
      entityId: String(filingId),
      before: null,
      after: { attachmentId: row.id, filename, sizeBytes: data.length },
    });
    return row;
  });
}

/**
 * Read + decrypt one attachment for download. Every download is audit-logged
 * (the bytes can contain the EIN — same doctrine as export access logging).
 */
export async function readFilingAttachment(
  deps: Deps,
  filingId: number,
  attachmentId: number,
  actorId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { db, config } = deps;
  const rows = await db
    .select()
    .from(filingAttachments)
    .where(and(eq(filingAttachments.id, attachmentId), eq(filingAttachments.filingId, filingId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new FilingServiceError(
      "not_found",
      `attachment ${attachmentId} on filing ${filingId} not found`,
    );
  }
  await db.insert(auditEvents).values({
    actorId,
    action: "tax_filing.download_attachment",
    entity: "tax_filing",
    entityId: String(filingId),
    before: null,
    after: { attachmentId, filename: row.filename },
  });
  return { filename: row.filename, data: decryptBytes(row.data, config.encryptionKey) };
}
