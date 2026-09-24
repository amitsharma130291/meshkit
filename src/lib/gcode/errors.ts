/**
 * Error translation for the G-code engine. Most malformed/unsupported
 * content is deliberately never an exception here — it's an honest
 * partial/warning result instead (see `analyze.ts`'s own `status`
 * field), matching "a ceiling hit reports a partial state, never a false
 * successful visualization." This module only covers the small set of
 * genuinely unrecoverable failures: an empty file, or a file the browser
 * itself couldn't read.
 */
import { createSafeError, type ErrorCode, type SafeError } from "../errors";

export type GCodeErrorCode = Extract<ErrorCode, `GCODE_${string}`>;

export class GCodeParseException extends Error {
  readonly code: GCodeErrorCode;

  constructor(code: GCodeErrorCode) {
    super(code);
    this.name = "GCodeParseException";
    this.code = code;
  }
}

export function gcodeError(code: GCodeErrorCode): GCodeParseException {
  return new GCodeParseException(code);
}

export function toGCodeSafeError(error: unknown): SafeError {
  if (error instanceof GCodeParseException) return createSafeError(error.code);
  return createSafeError("UNKNOWN_ERROR");
}
