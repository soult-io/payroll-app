/**
 * Deposit attachments (PAY-27) — EFTPS payment confirmation documents
 * (acknowledgment PDFs / receipts) uploaded to a tax deposit: the documentary
 * evidence behind the deposit row's eftps_confirmation number (PAY-9).
 *
 * Mirrors the PAY-24 filing-attachments doctrine: external record documents,
 * so the uploaded file is stored as-is; because confirmations can carry the
 * EIN, the bytes are AES-256-GCM encrypted at rest (encryptBytes/
 * decryptBytes, same SECRETS_DIR key as tax_id/bank_details); decryption
 * happens only when an authorized admin downloads the file. Upload and
 * download are audit-logged.
 */

import { and, asc, eq } from "drizzle-orm";
import { auditEvents, depositAttachments, taxDeposits } from "@payroll/db";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { decryptBytes, encryptBytes } from "../crypto/field-encryption.js";
import { MAX_ATTACHMENT_BYTES, PDF_MAGIC, sanitizeFilename } from "../filings/attachments.js";
import { DepositServiceError } from "./service.js";

export interface DepositAttachmentMeta {
  id: number;
  depositId: number;
  filename: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date | null;
}

const META_COLUMNS = {
  id: depositAttachments.id,
  depositId: depositAttachments.depositId,
  filename: depositAttachments.filename,
  sizeBytes: depositAttachments.sizeBytes,
  uploadedBy: depositAttachments.uploadedBy,
  createdAt: depositAttachments.createdAt,
} as const;

interface Deps {
  db: Db;
  config: AppConfig;
}

/** Returns the deposit's status; throws not_found when it does not exist. */
async function depositExists(db: Db, depositId: number): Promise<string> {
  const rows = await db
    .select({ id: taxDeposits.id, status: taxDeposits.status })
    .from(taxDeposits)
    .where(eq(taxDeposits.id, depositId))
    .limit(1);
  if (!rows[0]) throw new DepositServiceError("not_found", `tax deposit ${depositId} not found`);
  return rows[0].status;
}

export async function listDepositAttachments(
  db: Db,
  depositId: number,
): Promise<DepositAttachmentMeta[]> {
  await depositExists(db, depositId);
  return db
    .select(META_COLUMNS)
    .from(depositAttachments)
    .where(eq(depositAttachments.depositId, depositId))
    .orderBy(asc(depositAttachments.id));
}

/**
 * Store an upload (PDF only, magic-byte verified, size-capped). The audit
 * row lands in the same transaction as the insert.
 */
export async function addDepositAttachment(
  deps: Deps,
  depositId: number,
  input: { filename: string; data: Buffer },
  actorId: string,
): Promise<DepositAttachmentMeta> {
  const { db, config } = deps;
  const status = await depositExists(db, depositId);
  // Spec 23 §5: a replaced (superseded) row takes no new evidence.
  if (status === "superseded") {
    throw new DepositServiceError(
      "invalid_transition",
      "This deposit was replaced and takes no new attachments.",
    );
  }
  const { data } = input;
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
    throw new DepositServiceError(
      "invalid_input",
      `attachment must be 1 byte – ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  }
  if (!data.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new DepositServiceError("invalid_input", "attachment must be a PDF (%PDF magic bytes)");
  }
  const filename = sanitizeFilename(input.filename);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(depositAttachments)
      .values({
        depositId,
        filename,
        sizeBytes: data.length,
        data: encryptBytes(data, config.encryptionKey),
        uploadedBy: actorId,
      })
      .returning(META_COLUMNS);
    const row = inserted[0];
    if (!row) throw new Error("deposit attachment insert failed");
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_deposit.attach",
      entity: "tax_deposit",
      entityId: String(depositId),
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
export async function readDepositAttachment(
  deps: Deps,
  depositId: number,
  attachmentId: number,
  actorId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { db, config } = deps;
  const rows = await db
    .select()
    .from(depositAttachments)
    .where(
      and(eq(depositAttachments.id, attachmentId), eq(depositAttachments.depositId, depositId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DepositServiceError(
      "not_found",
      `attachment ${attachmentId} on deposit ${depositId} not found`,
    );
  }
  await db.insert(auditEvents).values({
    actorId,
    action: "tax_deposit.download_attachment",
    entity: "tax_deposit",
    entityId: String(depositId),
    before: null,
    after: { attachmentId, filename: row.filename },
  });
  return { filename: row.filename, data: decryptBytes(row.data, config.encryptionKey) };
}
