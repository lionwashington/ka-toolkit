// Shared logger seam for channel-core. The platform daemon (telegram/lark) owns
// the actual sink (file + stderr) and injects it via setLogger() in main(). Core
// modules call log() without knowing where it goes. Defaults to a no-op so that
// importing core for unit tests is silent and side-effect-free.
let _log: (msg: string) => void = () => {}

export function setLogger(fn: (msg: string) => void): void {
  _log = fn
}

export function log(msg: string): void {
  _log(msg)
}
