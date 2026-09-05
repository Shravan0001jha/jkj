/** Dead simple prefixed logging. Swap for pino when we need structure. */
const stamp = () => new Date().toTimeString().slice(0, 8);

export const log = {
  info: (scope: string, msg: string) => console.log(`${stamp()} ${scope.padEnd(8)} ${msg}`),
  warn: (scope: string, msg: string) => console.warn(`${stamp()} ${scope.padEnd(8)} ${msg}`),
  error: (scope: string, msg: string) => console.error(`${stamp()} ${scope.padEnd(8)} ${msg}`),
};
