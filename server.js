'use strict';

// Minimal Node.js HTTP server: it answers GET /hello, answers everything else
// with a plain-text 404, logs every request, and shuts down cleanly on CTRL+C.
// The built-in `http` module is the only dependency; there is no framework, no
// middleware and no router.

const http = require('http');

const DEFAULT_PORT = 3000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const CONTENT_TYPE = 'text/plain';
const HELLO_BODY = 'Hello world';
const NOT_FOUND_BODY = 'Not Found';

const SHUTDOWN_FALLBACK_MS = 5000;

// Request targets are parsed against this constant base, never against the
// Host header, so a client cannot influence how its own target is interpreted.
const PARSE_BASE = 'http://localhost';

// One entry per route: an exact, case-sensitive pathname mapped to its handler.
// A Map is used so a lookup miss is unambiguous whatever the pathname is.
const ROUTES = new Map([['/hello', handleHello]]);

function resolvePort() {
  const rawPort = process.env.PORT;

  if (rawPort === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error(
      `Invalid PORT "${rawPort}": expected an integer between ${MIN_PORT} and ${MAX_PORT}.`
    );
  }

  const port = Number(rawPort);

  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Invalid PORT "${rawPort}": must be between ${MIN_PORT} and ${MAX_PORT}.`);
  }

  return port;
}

function logRequest(method, target) {
  console.log(`${new Date().toISOString()} ${method} ${target}`);
}

function parsePath(target) {
  if (typeof target !== 'string') {
    return null;
  }

  try {
    return new URL(target, PARSE_BASE).pathname;
  } catch {
    return null;
  }
}

function sendResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', CONTENT_TYPE);
  res.end(body);
}

function handleHello(req, res) {
  sendResponse(res, 200, HELLO_BODY);
}

function handleNotFound(req, res) {
  sendResponse(res, 404, NOT_FOUND_BODY);
}

function handleRequest(req, res) {
  logRequest(req.method, req.url);

  const handler = req.method === 'GET' ? ROUTES.get(parsePath(req.url)) : undefined;
  (handler || handleNotFound)(req, res);
}

// Server state owned by the bootstrap below and read by shutdown(): the
// listening server, the port it was bound to, its live connections, and a flag
// that makes shutdown idempotent so a second CTRL+C prints no second line.
let server = null;
let boundPort = null;
let sockets = null;
let isShuttingDown = false;

// Live connections are tracked so the shutdown below can release them: Node's
// server.close() stops accepting new connections but leaves idle keep-alive
// sockets open and its callback waits for every connection to finish, so a
// browser tab left open would make CTRL+C appear to hang.
function trackSockets(server) {
  const sockets = new Set();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return sockets;
}

function onServerError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set a different PORT and try again.`);
  } else {
    console.error(`Failed to start server on port ${port}: ${err.code}`);
  }

  process.exitCode = 1;
}

function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`Server shutting down on port ${boundPort}`);

  const fallback = setTimeout(() => {
    for (const socket of sockets) {
      socket.destroy();
    }

    process.exit(0);
  }, SHUTDOWN_FALLBACK_MS);

  fallback.unref();

  server.close(() => {
    clearTimeout(fallback);

    // The exit code is set instead of the process being forced to exit:
    // process.exit() terminates even with pending work, and stdout writes are
    // asynchronous when the stream is a pipe, so forcing the exit here could
    // truncate the shutdown line just written. The process is left to exit on
    // its own once the event loop drains and the line has been flushed.
    process.exitCode = 0;
  });

  // Ending every tracked socket is what actually releases the connections.
  // end() flushes anything already queued and then closes, and it releases a
  // connection that has never sent a request - the idle keep-alive socket a
  // browser holds open. closeIdleConnections() and closeAllConnections() would
  // do part of this, but both were added in Node 18.2.0 and so cannot be used
  // on the Node 18.0.0 floor this project declares.
  for (const socket of sockets) {
    socket.end();
  }
}

function startServer() {
  let port;

  try {
    port = resolvePort();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  boundPort = port;
  server = http.createServer(handleRequest);
  sockets = trackSockets(server);

  server.on('error', (err) => onServerError(err, port));
  server.on('listening', () => console.log(`Server listening on port ${port}`));

  process.on('SIGINT', shutdown);

  server.listen(port);
}

startServer();
