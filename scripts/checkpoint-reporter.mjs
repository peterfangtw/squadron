// Structured lifecycle evidence; this reporter grants no authority to reuse results.
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (!['test:complete', 'test:fail', 'test:summary'].includes(type)) continue;
    yield JSON.stringify({
      type,
      data: {
        file: data.file,
        name: data.name,
        nesting: data.nesting,
        line: data.line,
        column: data.column,
        success: data.success,
        counts: data.counts,
        details: data.details && {
          passed: data.details.passed,
          type: data.details.type,
          duration_ms: data.details.duration_ms,
          error: data.details.error && {
            failureType: data.details.error.failureType,
            exitCode: data.details.error.exitCode,
            signal: data.details.error.signal
          }
        }
      }
    }) + '\n';
  }
}
