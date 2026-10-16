# nodejs-tutorial-hello-world

A single-file, dependency-free Node.js HTTP server written as a teaching reference. One
endpoint answers `GET /hello` with `Hello world`; every other request answers `404` with
`Not Found`. It is built on Node.js's built-in `http` module and nothing else — no
framework, no middleware, no routing library and no package to install — so the whole
program fits in one file you can read top to bottom and run with a single command.

## What it does

| Request | Status | `Content-Type` | Body |
|---------|--------|----------------|------|
| `GET /hello` | `200` | `text/plain` | `Hello world` |
| Any other method or path | `404` | `text/plain` | `Not Found` |

Routing rules you can verify straight away:

- Matching is exact and case-sensitive: `GET /hello/` and `GET /HELLO` are both `404`.
- Matching is method-aware: `POST /hello` and `HEAD /hello` reach the catch-all and answer
  `404`, because `GET /hello` is the only route there is.
- The query string is stripped before a request is matched and before it is logged, so
  `GET /hello?x=1` answers `200` and logs `/hello`.

## Prerequisites

- **Node.js 18.0.0 or later to run the server.** That is the floor the project declares in
  `package.json` as `"engines": { "node": ">=18.0.0" }`, and the application uses no API
  newer than it.
- **Node.js 18.1.0 or later to run the tests.** The bundled harness is launched with the
  `node --test` flag, which arrived in 18.1.0 — one minor above the application's own
  floor. The two floors differ; running the server needs only 18.0.0, running its tests
  needs 18.1.0.

Nothing else is required.

## Installation

None. The project declares no dependency, so there is no `npm install` step and no
`node_modules` directory: copy or clone the folder, make sure Node.js is on your `PATH`,
and run it.

## Running the server

```bash
node server.js
```

`npm start` runs the same command through the manifest:

```bash
npm start
```

The server listens on port 3000 unless the `PORT` environment variable says otherwise (see
**Configuration: the `PORT` environment variable** below), and prints one line to stdout as
soon as the port is bound:

```text
Server listening on port 3000
```

It then stays in the foreground serving requests until you stop it. It binds no specific
host, so it listens on all interfaces: `localhost` works from the same machine, and a
container port mapping or a forwarded port reaches it too.

## Verifying it works

With the server running, request the endpoint:

```bash
curl http://localhost:3000/hello
```

```text
Hello world
```

The body is exactly `Hello world` — 11 bytes, with no trailing newline.

Every request also prints one line to stdout. The line is written before the
request is routed, so unmatched requests are logged too:

```text
[2026-10-16T18:01:38.872Z] GET /hello
```

The timestamp is the moment the request arrived, in ISO-8601 UTC form, so yours will
differ. Only the timestamp is bracketed; the method and the query-stripped path follow it
bare.

Add `-i` to see the status line and the headers. `Date`, `Connection`, `Keep-Alive` and
`Content-Length` are supplied by Node.js itself:

```bash
curl -i http://localhost:3000/hello
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain
Date: Fri, 16 Oct 2026 20:56:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 11

Hello world
```

The body follows the blank line and carries no trailing newline of its own. Header order and
the keep-alive headers are Node.js's own and can differ between runtime versions; what this
project fixes is the status, `Content-Type: text/plain` with no charset parameter, the body
and its length.

Any other path returns the catch-all:

```bash
curl -i http://localhost:3000/invalid
```

```text
HTTP/1.1 404 Not Found
Content-Type: text/plain
Date: Fri, 16 Oct 2026 20:56:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 9

Not Found
```

So does a request whose method is not `GET`:

```bash
curl -i -X POST http://localhost:3000/hello
```

```text
HTTP/1.1 404 Not Found
Content-Type: text/plain
Date: Fri, 16 Oct 2026 20:56:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 9

Not Found
```

`HEAD /hello` is a `404` as well, and a `HEAD` response carries no body, so Node.js sends
neither `Content-Length` nor `Transfer-Encoding`:

```bash
curl -I http://localhost:3000/hello
```

```text
HTTP/1.1 404 Not Found
Content-Type: text/plain
Date: Fri, 16 Oct 2026 20:56:45 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

## Expected output examples

A whole session, from start to stop. This one was started with `PORT=4000 node server.js`
and received two requests, then `CTRL+C`:

```text
$ PORT=4000 node server.js
Server listening on port 4000
[2026-10-16T18:01:38.872Z] GET /hello
[2026-10-16T18:01:39.104Z] GET /invalid
Server shutting down
```

`Server listening on port 4000` is printed once the port is bound, naming the port the
process is actually listening on. The two bracketed lines are the request log, one line per
request; their timestamps are the current UTC time in ISO-8601 form and differ from request
to request. `Server shutting down` is printed to stdout when `CTRL+C` is pressed, after
which the process exits with status `0`.

Every response this server can produce is shown above: `200` for `GET /hello`, `404` for
every other request. The one other message a user sees is the configuration error for an
unusable `PORT`, shown in the next section.

## Configuration: the `PORT` environment variable

`PORT` is the only configuration input. It is read from the process environment once, at
startup.

| Value | Result |
|-------|--------|
| unset, or set to an empty string | the port `3000` |
| a string of digits whose numeric value is at least `1024` and at most `65535` | that port, both bounds inclusive |
| any other value | an error naming the value on stderr, then exit status `1` |

Because the accepted range starts at `1024`, privileged ports are refused: `PORT=80` fails
the same range check as any other out-of-range value, and there is no switch that overrides
it. Leading zeros are read as their numeric value, so `PORT=03000` is port 3000.

```bash
PORT=4000 node server.js
```

```text
Server listening on port 4000
```

Values that are not digit strings, including `abc`, `3000.5`, ` 3000` and `+3000`, and
values outside the range, including `0`, `80` and `65536`, all fail the same way:

```bash
PORT=abc node server.js
```

```text
Error: Invalid PORT value "abc". PORT must be an integer between 1024 and 65535.
```

That line goes to stderr, nothing is bound, and the exit status is `1`. The offending value
is quoted in the message exactly as it was read from the environment.

## Stopping the server

Press `CTRL+C` in the terminal that is running the server. It prints:

```text
Server shutting down
```

then stops accepting new connections, lets in-flight requests finish, closes idle keep-alive
connections and exits with status `0`. The same signal sent from another shell (for example
`kill -INT <pid>`) behaves identically.

## Troubleshooting

| Symptom | What to do |
|---------|------------|
| `Error: Port 4000 is already in use. Stop the process using it or set PORT to a free port.` (stderr, exit status `1`) | Another process holds that port. Stop it, or start this server on a free one: `PORT=4001 node server.js`. |
| `Error: Invalid PORT value "abc". PORT must be an integer between 1024 and 65535.` | `PORT` is not a string of digits in the accepted range. Correct it — `PORT=5000 node server.js` — or unset it to use port 3000. |
| `Error: Server could not start on port 4000: <error code or message>. Confirm the port is within 1024-65535 and is not reserved by another process.` (stderr, exit status `1`) | The bind failed for a reason other than a busy port, and the message names the runtime's error code, or its message when no code is set. Choose another port in `1024`–`65535`. |
| `curl: (7) Failed to connect to localhost port 3000 after 0 ms: Could not connect to server` | Nothing is listening there. Start the server and check the port in its startup line, or the port you passed in `PORT`. |

## Test harness

The repository ships one test file, `test/server.test.js`, which re-runs the project's
gates against `server.js` as a child process, so every assertion observes the server's real
HTTP output, its stdout, its stderr and its exit status:

```bash
npm test
```

The same run without npm:

```bash
node --test test/server.test.js
```

It covers the `200` status, header and body of `GET /hello`; the `404` catch-all for unknown
paths, other methods, and the trailing-slash and upper-case variants; the query-string case;
one log line per request, in request order, written before the response; the startup line;
the `SIGINT` shutdown line and its exit status `0`; the default port; invalid and occupied
`PORT` values; fifty concurrent requests; and the warmed latency budget, which `GET /hello`
is specified to meet in under 10 ms — the handler performs a table lookup and no I/O, so it
answers well inside that.

The harness uses only Node.js built-in modules, so it needs nothing installed, but it does
need Node.js 18.1.0 or later for the `node --test` flag it is launched with.

## Manual memory-stability check

The handler keeps no state between requests and retains nothing from them, so memory
settles rather than growing with the number of requests served. To watch that, start the
server, note its resident set size, send a batch of requests, and compare:

```bash
PORT=4000 node server.js &
sleep 1
ps -o rss= -p $!
for i in $(seq 1 500); do curl -s -o /dev/null http://localhost:4000/hello; done
ps -o rss= -p $!
for i in $(seq 1 1000); do curl -s -o /dev/null http://localhost:4000/hello; done
ps -o rss= -p $!
```

Repeat the second loop and the sample that follows it once for each further 1000
requests, so the readings fall at 500, 1500, 2500 and 3500 requests.

The figure is in kilobytes. It rises while the runtime warms up and then stays in a band
instead of climbing with the request count: on a normal checkout it reads roughly 47 MB just
after startup, about 58 MB after the first 500 requests, and then 59 MB or so after 1500,
2500 and 3500 requests, batches in between drifting by a megabyte without changing the
trend. The runtime reclaims what each request allocates; growth that tracked the request
count would mean per-request retention, which the handler does not do.

Stop the background server with `kill %1`, or bring it to the foreground with `fg` and then
press `CTRL+C`.
