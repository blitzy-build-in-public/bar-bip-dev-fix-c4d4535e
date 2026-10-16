'use strict';

/*
 * test/server.test.js — the product's entire verification harness.
 *
 * Re-runs the plan's acceptance gates against server.js, driven as a child
 * process so every assertion observes the server's real stdout, stderr, HTTP
 * wire output and exit status. The harness uses only Node.js built-in modules
 * and depends on no package, so `npm test` passes on a clean checkout with
 * nothing installed.
 *
 * The harness floor is Node 18.1.0, the release that introduced `node --test`;
 * it declares tests with `test(name, fn)` alone, so it depends on neither
 * `describe` (18.6.0) nor the hook functions (18.8.0).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const APPLICATION_PATH = path.join(__dirname, '..', 'server.js');

const DEFAULT_PORT = 3000;
const HELLO_PATH = '/hello';
const HELLO_BODY = 'Hello world';
const NOT_FOUND_BODY = 'Not Found';
const PLAIN_TEXT = 'text/plain';
const HELLO_CONTENT_LENGTH = '11';
const NOT_FOUND_CONTENT_LENGTH = '9';
const STARTUP_PREFIX = 'Server listening on port ';
const SHUTDOWN_LINE = 'Server shutting down';
const INVALID_PORT_PREFIX = 'Error: Invalid PORT value "';
const INVALID_PORT_SUFFIX = '". PORT must be an integer between 1024 and 65535.';
const ADDRESS_IN_USE_PREFIX = 'Error: Port ';
const ADDRESS_IN_USE_SUFFIX = ' is already in use. Stop the process using it or set PORT to a free port.';

// A request log line is an ISO-8601 UTC timestamp in brackets, then the method
// and the query-stripped path: the brackets frame the timestamp only.
const REQUEST_LINE_PATTERN = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] (GET|POST) \/.*$/m;
const GET_HELLO_LINE_PATTERN = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] GET \/hello$/m;
const POST_HELLO_LINE_PATTERN = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] POST \/hello$/m;

// Every wait in this file takes its budget from one of these, so no test can
// wait without a bound.
const STARTUP_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 2000;
const OUTPUT_TIMEOUT_MS = 1000;
const POLL_INTERVAL_MS = 15;

/**
 * Return a port number that was free a moment ago.
 *
 * The probe closes before the number is handed out, so the port is free again
 * from the moment it is returned: an EADDRINUSE after this point comes from an
 * unrelated process and surfaces through startServer's rejection, not here.
 *
 * @returns {Promise<number>} The probed port number.
 */
function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);

    // No host argument, matching the application's own unhosted bind.
    probe.listen(0, () => {
      const { port } = probe.address();

      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Launch server.js as a child process and resolve once it reports a bound port.
 *
 * @param {Record<string, string>} env Environment overrides for the child; the
 *   rest of the environment is inherited, so the only difference from the parent
 *   is what the caller sets.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number,
 *   stdout: { text: string }, stderr: { text: string } }>} The running server.
 */
async function startServer(env) {
  const child = spawn(process.execPath, [APPLICATION_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Live accumulators: the resolved handle keeps growing as output arrives, so a
  // test can read the buffer long after the server has started.
  const stdout = { text: '' };
  const stderr = { text: '' };

  child.stdout.on('data', (chunk) => {
    stdout.text += String(chunk);
  });

  child.stderr.on('data', (chunk) => {
    stderr.text += String(chunk);
  });

  // 'close' rather than 'exit': it follows the stdio streams closing, so when it
  // fires the exit status and the complete piped output are both available. It
  // is registered once, here, so a start that fails reports the child's own
  // evidence instead of racing the reporter for it.
  const exitResult = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);
  const handle = { child, port, stdout, stderr };
  const startupMarker = STARTUP_PREFIX + port;

  const outcome = await Promise.race([
    waitForLine(handle, 'stdout', startupMarker, STARTUP_TIMEOUT_MS).then((line) => ({ kind: 'startup', line })),
    exitResult.then((result) => ({ kind: 'exit', result })),
  ]);

  if (outcome.kind === 'startup' && outcome.line !== null) {
    return handle;
  }

  if (outcome.kind === 'startup') {
    // The bounded startup wait expired with the child still alive: take it down,
    // so a failed start cannot leave a process behind holding a port.
    child.kill('SIGKILL');
  }

  const { code, signal } = outcome.kind === 'exit' ? outcome.result : { code: null, signal: null };
  const failure = new Error(
    `server.js did not report "${startupMarker}" within ${STARTUP_TIMEOUT_MS} ms ` +
      `(exit code ${code}, signal ${signal}). stdout: ${stdout.text.trim()} stderr: ${stderr.text.trim()}`
  );

  failure.exitCode = code;
  failure.signal = signal;
  failure.stdout = stdout.text;
  failure.stderr = stderr.text;

  throw failure;
}

/**
 * Perform one HTTP request against the server under test over loopback.
 *
 * @param {number} port The port the server is bound to.
 * @param {string} requestPath The request target, query string included.
 * @param {string} [method] The HTTP method; defaults to GET.
 * @returns {Promise<{ statusCode: number, headers: Record<string, string>, body: string }>}
 *   The response, with Node's lower-cased header object.
 */
function request(port, requestPath, method) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: method || 'GET',
        // agent: false gives every request its own short-lived socket. The shared
        // global agent keeps sockets alive on Node >= 19, and those idle sockets
        // would hold the test process open after the run has finished.
        agent: false,
      },
      (res) => {
        const chunks = [];

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: chunks.join('') });
        });
      }
    );

    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

/**
 * Stop a server started by startServer and report how it exited.
 *
 * Idempotent: a child that has already exited reports its recorded result, so a
 * test may stop the server in its own body and call this again from a finally
 * block. Leaving a child running would keep its pipes open and hang the run.
 *
 * @param {import('node:child_process').ChildProcess} child The child process.
 * @returns {Promise<{ code: number|null, signal: string|null }>} The exit result.
 */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  child.kill('SIGINT');

  // Bounded wait for the clean path; the unref'd timer cannot itself hold the
  // run open once the child has exited.
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, EXIT_TIMEOUT_MS);

    timer.unref();
  });

  const cleanExit = await Promise.race([exited, timeout]);

  if (cleanExit !== null) {
    return cleanExit;
  }

  // The clean path did not finish within its budget: force the process down, so
  // no child survives to hold the runner's pipes open.
  const forcedExit = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  child.kill('SIGKILL');

  return forcedExit;
}

/**
 * Wait, within a bounded budget, for a line to appear in a child's output.
 *
 * The server writes each line before it acts on the request, so the only latency
 * absorbed here is pipe delivery: a line already written may reach the
 * accumulator a few milliseconds later. The budget is always explicit, so a
 * missing line fails its test rather than hanging it.
 *
 * @param {{ stdout: { text: string }, stderr: { text: string } }} handle The handle startServer resolved with.
 * @param {'stdout'|'stderr'} streamName Which accumulator to poll.
 * @param {RegExp|string} pattern Line matcher: a RegExp tested per line, or a substring.
 * @param {number} timeoutMs The budget, in milliseconds.
 * @returns {Promise<string|null>} The matching line, or null once the budget expires.
 */
function waitForLine(handle, streamName, pattern, timeoutMs) {
  const matches =
    pattern instanceof RegExp ? (line) => pattern.test(line) : (line) => line.includes(pattern);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const poll = () => {
      const line = handle[streamName].text.split('\n').find((candidate) => matches(candidate));

      if (line !== undefined) {
        resolve(line);
        return;
      }

      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
  });
}

test('T1 GET /hello answers 200 text/plain with body Hello world', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });

  try {
    const response = await request(port, HELLO_PATH);

    assert.strictEqual(response.statusCode, 200, 'GET /hello must answer 200');
    assert.strictEqual(
      response.headers['content-type'],
      PLAIN_TEXT,
      'Content-Type must be text/plain with no charset parameter'
    );
    assert.strictEqual(
      response.headers['content-length'],
      HELLO_CONTENT_LENGTH,
      'Content-Length must be the exact length of Hello world'
    );
    assert.strictEqual(response.body, HELLO_BODY, 'the body must be Hello world with no trailing newline');
    assert.strictEqual(typeof response.headers.date, 'string', 'Node adds the Date header');
  } finally {
    await stopServer(handle.child);
  }
});

test('T2 unmatched paths answer 404 text/plain with body Not Found', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });
  // Matching is exact, case-sensitive and un-normalised: the trailing slash and
  // the upper-case variant miss the /hello route just as an unknown path does.
  const unmatchedPaths = ['/invalid', '/', '/hello/', '/HELLO'];

  try {
    for (const unmatchedPath of unmatchedPaths) {
      const response = await request(port, unmatchedPath);

      assert.strictEqual(response.statusCode, 404, `GET ${unmatchedPath} must answer 404`);
      assert.strictEqual(
        response.headers['content-type'],
        PLAIN_TEXT,
        `GET ${unmatchedPath} must answer Content-Type text/plain`
      );
      assert.strictEqual(
        response.headers['content-length'],
        NOT_FOUND_CONTENT_LENGTH,
        `GET ${unmatchedPath} must send the exact length of Not Found`
      );
      assert.strictEqual(response.body, NOT_FOUND_BODY, `GET ${unmatchedPath} must answer Not Found`);
    }
  } finally {
    await stopServer(handle.child);
  }
});

test('T3 POST and HEAD on /hello answer 404 through the catch-all', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });

  try {
    const postResponse = await request(port, HELLO_PATH, 'POST');

    assert.strictEqual(postResponse.statusCode, 404, 'POST /hello must answer 404: routing is method-aware');
    assert.strictEqual(postResponse.headers['content-type'], PLAIN_TEXT, 'POST /hello must answer text/plain');
    assert.strictEqual(
      postResponse.headers['content-length'],
      NOT_FOUND_CONTENT_LENGTH,
      'POST /hello must send the exact length of Not Found'
    );
    assert.strictEqual(postResponse.body, NOT_FOUND_BODY, 'POST /hello must answer Not Found');

    const headResponse = await request(port, HELLO_PATH, 'HEAD');

    assert.strictEqual(headResponse.statusCode, 404, 'HEAD /hello must answer 404: HEAD is not GET');
    assert.strictEqual(headResponse.headers['content-type'], PLAIN_TEXT, 'HEAD /hello must answer text/plain');
    assert.strictEqual(headResponse.body, '', 'a HEAD response carries no body');
    // Node sends a HEAD response bodyless, so it emits neither framing header.
    assert.strictEqual(
      headResponse.headers['content-length'],
      undefined,
      'HEAD must send no Content-Length'
    );
    assert.strictEqual(
      headResponse.headers['transfer-encoding'],
      undefined,
      'HEAD must send no Transfer-Encoding'
    );
  } finally {
    await stopServer(handle.child);
  }
});

test('T4 a query string is stripped before both matching and logging', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });

  try {
    const response = await request(port, HELLO_PATH + '?x=1');

    assert.strictEqual(response.statusCode, 200, 'GET /hello?x=1 must match the endpoint');
    assert.strictEqual(response.body, HELLO_BODY, 'GET /hello?x=1 must answer Hello world');

    const loggedLine = await waitForLine(handle, 'stdout', GET_HELLO_LINE_PATTERN, OUTPUT_TIMEOUT_MS);

    assert.notStrictEqual(loggedLine, null, 'GET /hello?x=1 must log the query-stripped path');
    assert.ok(!loggedLine.includes('?x=1'), 'the query string must not appear in the log line');
  } finally {
    await stopServer(handle.child);
  }
});

test('T5 every request logs one line before route handling, in request order', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });
  const { child, stdout } = handle;

  try {
    await request(port, HELLO_PATH);

    // The line is written before the route table is consulted, so the response
    // cannot have been produced before it. The poll below absorbs only pipe
    // delivery latency: the assertion runs once the line has arrived.
    const getLine = await waitForLine(handle, 'stdout', GET_HELLO_LINE_PATTERN, OUTPUT_TIMEOUT_MS);

    assert.notStrictEqual(getLine, null, 'GET /hello must log one line');

    await request(port, HELLO_PATH, 'POST');

    const postLine = await waitForLine(handle, 'stdout', POST_HELLO_LINE_PATTERN, OUTPUT_TIMEOUT_MS);

    assert.notStrictEqual(postLine, null, 'an unmatched request must be logged too');

    const requestLines = stdout.text.split('\n').filter((line) => REQUEST_LINE_PATTERN.test(line));

    assert.strictEqual(requestLines.length, 2, 'two requests must produce exactly two log lines');
    assert.ok(requestLines[0].endsWith('GET /hello'), 'the first line must carry the first request method and path');
    assert.ok(requestLines[1].endsWith('POST /hello'), 'the second line must carry the second request method and path');
    assert.ok(
      stdout.text.indexOf(getLine) < stdout.text.indexOf(postLine),
      'lines must be emitted in request order'
    );
  } finally {
    await stopServer(child);
  }
});

test('T6 the startup line names the port the server bound', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });

  try {
    const startupLine = await waitForLine(handle, 'stdout', STARTUP_PREFIX + port, OUTPUT_TIMEOUT_MS);

    assert.strictEqual(
      startupLine,
      STARTUP_PREFIX + port,
      'the startup line is literal and space-separated, with the bound port numeral last'
    );
  } finally {
    await stopServer(handle.child);
  }
});


test('T7 SIGINT logs the shutdown line and exits with status 0', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });
  const { child, stdout } = handle;

  try {
    // stopServer both signals the child and reports its exit result, so this test
    // need not observe the 'exit' event itself.
    const { code, signal } = await stopServer(child);

    assert.strictEqual(code, 0, 'SIGINT must exit with status 0');
    assert.strictEqual(signal, null, 'the clean path must not need the SIGKILL fallback');

    const shutdownLine = await waitForLine(handle, 'stdout', SHUTDOWN_LINE, OUTPUT_TIMEOUT_MS);

    assert.strictEqual(shutdownLine, SHUTDOWN_LINE, 'SIGINT must log the shutdown line');
    assert.ok(
      stdout.text.indexOf(STARTUP_PREFIX) < stdout.text.indexOf(SHUTDOWN_LINE),
      'the shutdown line must follow the startup line'
    );
  } finally {
    // The child has already exited by this point, so this is the idempotent no-op
    // path; it is here for the run in which an assertion above throws first.
    await stopServer(child);
  }
});

test('T8 an unset PORT binds the default port 3000', async () => {
  // Deliberately not allocateFreePort(): this gate is the default itself. It
  // fails legitimately when an unrelated process already holds port 3000, which
  // is a host condition rather than a product defect.
  const env = { ...process.env };

  delete env.PORT;

  const handle = await startServer(env);

  try {
    const startupLine = await waitForLine(handle, 'stdout', STARTUP_PREFIX + DEFAULT_PORT, OUTPUT_TIMEOUT_MS);

    assert.strictEqual(startupLine, STARTUP_PREFIX + DEFAULT_PORT, 'an unset PORT must default to 3000');
  } finally {
    await stopServer(handle.child);
  }
});

test('T9 an invalid PORT reports the accepted range on stderr and exits with status 1', async () => {
  // A non-digit string, a decimal, an out-of-range high value, an out-of-range
  // zero and a privileged port: each must be refused by the same range check.
  const invalidValues = ['abc', '3000.5', '65536', '0', '80'];

  for (const invalidValue of invalidValues) {
    await assert.rejects(
      startServer({ PORT: invalidValue }),
      (failure) => {
        assert.strictEqual(failure.exitCode, 1, `PORT=${invalidValue} must exit with status 1`);
        assert.ok(
          failure.stderr.includes(INVALID_PORT_PREFIX + invalidValue + INVALID_PORT_SUFFIX),
          `PORT=${invalidValue} must name the value and the accepted range, got: ${failure.stderr.trim()}`
        );
        assert.ok(!failure.stdout.includes(STARTUP_PREFIX), `PORT=${invalidValue} must not report a bound port`);
        return true;
      }
    );
  }
});

test('T10 an occupied port reports the address in use and exits with status 1', async () => {
  const holder = net.createServer();

  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    // No host argument, matching the application's own unhosted bind, so the two
    // compete for the same interface and the bind collides.
    holder.listen(0, resolve);
  });

  const heldPort = holder.address().port;

  try {
    await assert.rejects(
      startServer({ PORT: String(heldPort) }),
      (failure) => {
        assert.strictEqual(failure.exitCode, 1, 'a bind failure must exit with status 1');
        assert.ok(
          failure.stderr.includes(ADDRESS_IN_USE_PREFIX + heldPort + ADDRESS_IN_USE_SUFFIX),
          `the failure must name port ${heldPort} and what to do about it, got: ${failure.stderr.trim()}`
        );
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => {
      holder.close(resolve);
    });
  }
});

test('T11 fifty concurrent requests are all answered 200', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });
  const concurrency = 50;

  try {
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () => request(port, HELLO_PATH))
    );

    assert.strictEqual(responses.length, concurrency, 'the gate issues fifty concurrent requests');

    responses.forEach((response, index) => {
      assert.strictEqual(response.statusCode, 200, `concurrent request ${index} must answer 200`);
      assert.strictEqual(response.body, HELLO_BODY, `concurrent request ${index} must answer Hello world`);
    });
  } finally {
    await stopServer(handle.child);
  }
});

test('T12 warmed GET /hello answers in under 10 ms', async () => {
  const port = await allocateFreePort();
  const handle = await startServer({ PORT: String(port) });

  try {
    for (let warmUp = 0; warmUp < 5; warmUp += 1) {
      await request(port, HELLO_PATH);
    }

    const durationsMs = [];

    for (let sample = 0; sample < 20; sample += 1) {
      const startedAt = process.hrtime.bigint();
      const response = await request(port, HELLO_PATH);
      const elapsedNs = process.hrtime.bigint() - startedAt;

      assert.strictEqual(response.statusCode, 200, `sample ${sample} must answer 200`);
      durationsMs.push(Number(elapsedNs) / 1e6);
    }

    const minimumMs = Math.min(...durationsMs);

    assert.ok(
      minimumMs < 10,
      `the warmed round-trip minimum must be below 10 ms, measured ${minimumMs.toFixed(3)} ms`
    );
  } finally {
    await stopServer(handle.child);
  }
});
