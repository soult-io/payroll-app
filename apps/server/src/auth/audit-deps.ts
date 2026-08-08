/**
 * Small indirection so auth modules can import the Db type + audit helpers
 * without circular imports.
 */

export { writeAuthEvent, AUTH_EVENT, requestContext } from "./audit.js";
export type { Db } from "../db.js";
