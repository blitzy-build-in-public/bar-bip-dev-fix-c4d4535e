# Minimal Node.js HTTP server tutorial demonstrating single endpoint implementation

## Purpose

This project is a minimal Node.js HTTP server that answers one endpoint and nothing else. It is the reference implementation of the smallest complete Node.js server: a single file, built on the `http` module that ships with Node.js, with no framework, no middleware, no routing library and no third-party dependency of any kind.

Reading `server.js` end to end takes a few minutes, and running it takes one command. It serves two responses and nothing else:

| Request | Response |
| --- | --- |
| `GET /hello` | `200` with `Content-Type: text/plain` and the body `Hello world` |
| Everything else | `404` with `Content-Type: text/plain` and the body `Not Found` |

Alongside those responses it logs every request to the console before routing it, prints one line when it starts, and shuts down cleanly when you press CTRL+C.

The application itself is `server.js` alone. The other two files exist to run it and to explain it: `package.json` holds the project metadata and the start command, and this README walks through running the server and checking what it does.

This is a teaching example rather than a hardened production server. It has no authentication, no TLS, no data storage and no outbound requests, it never reads a request body, and it never puts anything a client sent into a response — both response bodies are fixed strings.

## Prerequisites

- **Node.js v18.0.0 or newer.** That is the version floor the project declares in `package.json`, under `engines.node`.

Check your version with:

```bash
node --version
```

The output looks like `v22.23.3`; any version `v18.0.0` or newer runs the server.

There is nothing else to install. The application uses only modules that ship with Node.js, so no compiler, no build step and no package installation are involved.

## Installation

None required. The project declares no dependencies, so there is nothing to download or install beyond Node.js itself: the three files in the repository root are the whole project.

## Execution

From the repository root, start the server with either of these commands:

```bash
node server.js
```

```bash
npm start
```

Both do the same thing — `npm start` runs `node server.js`. The server listens on port 3000 by default and prints one line:

```text
Server listening on port 3000
```

`npm start` echoes the command it runs, so with npm you see its own two-line banner above the line the server prints.

It then keeps running in the foreground and serves requests until you stop it, as described in [Shutdown](#shutdown). The number in that line is the port that was actually bound, so it changes when you set `PORT` — see [Environment variable configuration](#environment-variable-configuration).

The server binds its port on the machine's network interfaces, which is the Node.js default, so other devices on the same network can reach it. The examples below use `http://localhost:3000`, which works on the machine running the server.

## Testing

With the server running in one terminal, send a request from another terminal to the one route it serves:

```bash
curl http://localhost:3000/hello
```

```text
Hello world
```

Then ask for a path that does not exist:

```bash
curl http://localhost:3000/invalid
```

```text
Not Found
```

Add `-i` to a request to see the status line and headers as well as the body:

```bash
curl -i http://localhost:3000/hello
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain
Date: Sun, 18 Oct 2026 13:06:39 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 11

Hello world
```

The `Date` header is the time of the request and the keep-alive headers describe the connection; the status, `Content-Type: text/plain` and the body are what this application sets. The same request with `-i` against `/invalid` answers with `HTTP/1.1 404 Not Found`, `Content-Length: 9` and the body `Not Found`.

While you make these requests, the terminal running the server prints one log line for each of them — see [Expected output](#expected-output). If you set `PORT`, use that port in the URLs instead of 3000.

## Expected output

**Startup.** One line when the server begins listening:

```text
Server listening on port 3000
```

**Per request.** Every request is logged to the console before it is routed, in the form `<ISO-8601 timestamp> <HTTP method> <request path>`: three space-separated fields and no brackets.

```text
2026-10-18T13:06:39.482Z GET /hello
2026-10-18T13:06:41.007Z GET /invalid
2026-10-18T13:06:42.115Z POST /hello
```

The timestamp is UTC with millisecond precision. The third field is the request target exactly as the client sent it, so a query string appears in the log as `GET /hello?name=student`.

**Responses.** Routing compares the pathname of the request against the single route `/hello`, exactly and case-sensitively, so these are the outcomes:

| Request | Status | Body | Why |
| --- | --- | --- | --- |
| `GET /hello` | `200` | `Hello world` | the path matches the route |
| `GET /hello?name=student` | `200` | `Hello world` | a query string is not part of the pathname, so the route still matches |
| `GET /invalid` | `404` | `Not Found` | no route matches the path |
| `GET /hello/`, `GET /HELLO`, `GET /hello/extra`, `GET /` | `404` | `Not Found` | matching is exact and case-sensitive |
| `POST /hello`, or any other non-`GET` method on any path | `404` | `Not Found` | the route is served for `GET` only; there is no `405` and no `201` |

Because only `GET` is served, `HEAD /hello` is the `404` as well; a `HEAD` response carries the status and `Content-Type: text/plain` with no body and no `Content-Length`.

**Speed.** Measured on loopback — client and server on the same machine, with the connection setup included in each measurement — the `/hello` response arrives in under 10 milliseconds.

## Shutdown

Stop the server with CTRL+C in the terminal where it is running. It logs one line:

```text
Server shutting down on port 3000
```

and then exits with status `0`. Open connections are released as part of the shutdown, so the port is free as soon as the process has exited and it does not have to be killed.

Pressing CTRL+C again while the shutdown is in progress prints nothing further; the shutdown runs once.

## Environment variable configuration

One environment variable configures the server:

| Variable | Default | Accepted values |
| --- | --- | --- |
| `PORT` | `3000` | A whole number from `1024` to `65535` |

`PORT` is read once, at startup, from the process environment, and it replaces the default port:

```bash
PORT=4000 node server.js
```

```text
Server listening on port 4000
```

The server then answers on port 4000, so the requests in [Testing](#testing) become `curl http://localhost:4000/hello`. With `npm start` the same override reads `PORT=4000 npm start`.

**Invalid values.** A `PORT` that is not a whole number, or that falls outside 1024-65535, stops the server before it binds, reports the offending value on standard error, and exits with status `1`:

```bash
PORT=abc node server.js
```

```text
Invalid PORT "abc": expected an integer between 1024 and 65535.
```

```bash
PORT=70000 node server.js
```

```text
Invalid PORT "70000": must be between 1024 and 65535.
```

Values below 1024 are rejected by the same rule, which is why the server does not bind a privileged port.

**Port already in use.** Starting a second server on a port that is already taken reports it in one line and exits with status `1`, with no stack trace:

```text
Port 3000 is already in use. Set a different PORT and try again.
```

The number in that message is the port that was attempted. Either set a different `PORT`, or stop the server that is already running, as described in [Shutdown](#shutdown).
