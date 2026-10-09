// On Fly the app stops itself once nobody has used it for a while and
// nothing is running in the background (answer PDFs being matched, sections
// being marked, reports being written, a zip being printed), and Fly starts
// it again on the next visit (fly.toml: auto_stop_machines = 'off',
// auto_start_machines = true). Fly's own stopping goes by web traffic alone,
// so it could stop the app in the middle of that work once the page was
// closed. Off Fly (on a laptop) the app never stops itself.
const IDLE_MS = Number(process.env.IDLE_STOP_MINUTES || 10) * 60 * 1000;

let busy = 0;
let lastActive = Date.now();

const begin = () => {
  busy += 1;
  lastActive = Date.now();
};
const end = () => {
  busy -= 1;
  lastActive = Date.now();
};

// Express middleware: a request in progress counts as use. It goes after the
// health check, since Fly's health checks must not count, or the app would
// never be idle.
export function trackRequests(req, res, next) {
  begin();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    end();
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

// Keeps the app running until `promise` settles. The promise is returned as
// it is, for the caller to handle as before.
export function keepAwake(promise) {
  begin();
  promise.finally(end).catch(() => {});
  return promise;
}

if (process.env.FLY_APP_NAME) {
  setInterval(() => {
    if (busy > 0 || Date.now() - lastActive < IDLE_MS) return;
    console.log('Nobody is using the app and nothing is running, so it stops until the next visit.');
    process.exit(0);
  }, Math.min(60_000, IDLE_MS / 2)).unref();
}
