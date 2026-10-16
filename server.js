/*
 * server.js — single-file Node.js HTTP server for the hello-world tutorial.
 *
 * Serves GET /hello with "Hello world" and answers every other request with
 * 404 "Not Found". The listening port comes from the PORT environment variable
 * and defaults to 3000; SIGINT shuts the process down cleanly.
 */

const http = require('http');

const DEFAULT_PORT = 3000;
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const HELLO_PATH = '/hello';
const HELLO_BODY = 'Hello world';
const NOT_FOUND_BODY = 'Not Found';

/**
 * Convert the PORT environment value into a bindable port number.
 *
 * @param {string|undefined} rawValue Raw value of process.env.PORT.
 * @returns {number|null} The port, or null when the value is not a string of
 *   digits whose numeric value lies within PORT_MIN..PORT_MAX.
 */
function parsePort(rawValue) {
  // A digit-only test is what rejects '3000abc', ' 3000', '+3000', '0xbb8' and
  // '3e3' — every one of which a bare parseInt would accept or misread.
  if (typeof rawValue !== 'string' || !/^[0-9]+$/.test(rawValue)) {
    return null;
  }

  const port = Number(rawValue);

  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return null;
  }

  return port;
}

/**
 * Derive the request path used for both logging and route matching.
 *
 * @param {string} requestUrl The request target, possibly carrying a query string.
 * @returns {string} The target up to the first '?', so '/hello?x=1' yields '/hello'.
 */
function pathnameOf(requestUrl) {
  const queryStart = requestUrl.indexOf('?');

  return queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
}

/**
 * Write the single stdout line that records an incoming request.
 *
 * @param {string} method The HTTP method.
 * @param {string} pathname The query-stripped request path.
 */
function logRequest(method, pathname) {
  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);
}

/**
 * Write a plain-text response.
 *
 * Status and header are set on the response object and only then is the body
 * passed to end(), which is the shape Node's own server documentation uses:
 * end() lets Node compute Content-Length, whereas writing the headers out
 * explicitly beforehand would switch the response to Transfer-Encoding: chunked
 * and drop that length.
 *
 * @param {http.ServerResponse} res The response to write.
 * @param {number} statusCode The status code to send.
 * @param {string} body The plain-text body to send.
 */
function sendPlainText(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
}

/**
 * Handle GET /hello.
 *
 * @param {http.IncomingMessage} req The incoming request.
 * @param {http.ServerResponse} res The response to write.
 */
function handleHelloRoute(req, res) {
  sendPlainText(res, 200, HELLO_BODY);
}

/**
 * Handle every request that matches no route.
 *
 * @param {http.IncomingMessage} req The incoming request.
 * @param {http.ServerResponse} res The response to write.
 */
function handleNotFoundRoute(req, res) {
  sendPlainText(res, 404, NOT_FOUND_BODY);
}

// Route table: method -> path -> handler. Built once at module load, never
// mutated, so adding an endpoint is one handler plus one entry.
const ROUTES = new Map([
  ['GET', new Map([[HELLO_PATH, handleHelloRoute]])],
]);

/**
 * Route an incoming request: log it, resolve its handler, dispatch or fall
 * through to the catch-all.
 *
 * @param {http.IncomingMessage} req The incoming request.
 * @param {http.ServerResponse} res The response to write.
 */
function requestHandler(req, res) {
  const pathname = pathnameOf(req.url);

  // Logged before route handling, so unmatched requests are logged as well.
  logRequest(req.method, pathname);

  const methodRoutes = ROUTES.get(req.method);
  const handler = methodRoutes === undefined ? undefined : methodRoutes.get(pathname);

  if (handler === undefined) {
    handleNotFoundRoute(req, res);
    return;
  }

  handler(req, res);
}

/**
 * Validate the configuration, create the server and start listening.
 */
function start() {
  const rawPort = process.env.PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : parsePort(rawPort);

  if (port === null) {
    console.error(`Error: Invalid PORT value "${rawPort}". PORT must be an integer between ${PORT_MIN} and ${PORT_MAX}.`);
    process.exit(1);
  }

  const server = http.createServer(requestHandler);

  // listen() reports a bind failure as an asynchronous 'error' event that the
  // listen callback never receives, so the listener is registered beforehand.
  server.on('error', (err) => {
    handleServerError(err, port);
  });

  process.on('SIGINT', () => {
    shutdown(server);
  });

  // No host argument, so the server listens on all available interfaces.
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

/**
 * Report a bind failure on stderr and exit with status 1.
 *
 * @param {Error & { code?: string }} err The error emitted by the server.
 * @param {number} port The port the server failed to bind.
 */
function handleServerError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${port} is already in use. Stop the process using it or set PORT to a free port.`);
  } else {
    console.error(
      `Error: Server could not start on port ${port}: ${err.code || err.message}. ` +
        `Confirm the port is within ${PORT_MIN}-${PORT_MAX} and is not reserved by another process.`
    );
  }

  process.exit(1);
}

// Set by the first shutdown, so a second SIGINT delivered while close() is still
// waiting on an in-flight connection cannot repeat the shutdown line or re-arm
// the close timer.
let isShuttingDown = false;

/**
 * Shut the server down on SIGINT: report it, stop accepting connections, close
 * them, and exit with status 0.
 *
 * @param {http.Server} server The running server.
 */
function shutdown(server) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log('Server shutting down');

  server.close(() => {
    process.exit(0);
  });

  // closeIdleConnections() arrived in Node 18.2.0 while the supported floor is
  // 18.0.0, so it is called only when the runtime provides it: on Node 18
  // close() leaves idle keep-alive sockets open, a behaviour changed in v19.0.0.
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  // Force the promised status 0 if a lingering socket holds the event loop past
  // the close callback; the timer is unref'd so it cannot itself delay the exit.
  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
}

start();
