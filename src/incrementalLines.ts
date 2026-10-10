export type IncrementalLineState = { remainder: Buffer };

export function takeCompleteLines(state: IncrementalLineState, chunk: Buffer): string[] {
  const combined = Buffer.concat([state.remainder, chunk]);
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    state.remainder = combined;
    return [];
  }

  const complete = combined.subarray(0, lastNewline).toString('utf8');
  state.remainder = Buffer.from(combined.subarray(lastNewline + 1));
  return complete.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}