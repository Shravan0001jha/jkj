/**
 * Errors the caller caused, separated from errors JKJ caused.
 *
 * Without the distinction every mistake is a 500, which tells the browser
 * "the server broke" when the truth is "that file cannot be read".
 */
export class BadRequest extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export const statusOf = (err: unknown): number =>
  err instanceof BadRequest ? err.status : 500;
