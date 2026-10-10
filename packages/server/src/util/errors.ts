/**
 * Errors the caller caused, separated from errors the Workplace caused.
 *
 * Without the distinction every mistake is a 500, which tells the browser
 * "the server broke" when the truth is "that file cannot be read".
 */
export class BadRequest extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** The request was fine, but the world moved: answered twice, applied twice. */
export class Conflict extends BadRequest {
  override readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'Conflict';
  }
}

export class NotFound extends BadRequest {
  override readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/** Off-loopback without the bearer token. */
export class Unauthorized extends BadRequest {
  override readonly status = 401;

  constructor(message = 'A bearer token is required off loopback.') {
    super(message);
    this.name = 'Unauthorized';
  }
}

export const statusOf = (err: unknown): number =>
  err instanceof BadRequest ? err.status : 500;

/** A body or file over the size the route takes. */
export class TooLarge extends BadRequest {
  override readonly status = 413;

  constructor(message: string) {
    super(message);
    this.name = 'TooLarge';
  }
}

/** A dependency the Workplace relies on (speech-to-text) failed. */
export class Upstream extends BadRequest {
  override readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'Upstream';
    this.status = status;
  }
}

/** The tree says no (rework, Oct 2026): only the assignee or someone above them changes a story. */
export class Forbidden extends BadRequest {
  override readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'Forbidden';
  }
}
