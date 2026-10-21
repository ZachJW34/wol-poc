import type { ErrorCode, FieldName } from "../shared/contracts";

/**
 * Handled API failure. The handler renders this as the shared error envelope, so
 * nothing here may carry stack traces, SQL, filesystem paths, or subprocess output.
 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Partial<Record<FieldName, string>>;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    fields?: Partial<Record<FieldName, string>>,
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}
