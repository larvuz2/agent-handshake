// Streaming Server-Sent Events transform for MCP responses.
// Calls onMessage(msg) for every JSON-RPC message in the stream. If it returns a
// different object, that event's data is rewritten; otherwise the event passes
// through byte-for-byte.

export async function transformSse(webStream, write, onMessage) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flushEvent = async (raw, sep) => {
    const lines = raw.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) return write(raw + sep);
    let msg;
    try {
      msg = JSON.parse(dataLines.join('\n'));
    } catch {
      return write(raw + sep);
    }
    const out = await onMessage(msg);
    if (out === undefined || out === msg) return write(raw + sep);
    const kept = lines.filter((l) => !l.startsWith('data:'));
    return write([...kept, `data: ${JSON.stringify(out)}`].join('\n') + sep);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index);
      const sep = m[0];
      buf = buf.slice(m.index + sep.length);
      await flushEvent(raw, sep);
    }
  }
  buf += decoder.decode();
  if (buf.length) await flushEvent(buf, '');
}

// Parse a whole SSE body (string) into JSON-RPC messages.
export function parseSseMessages(text) {
  const out = [];
  for (const raw of text.split(/\r?\n\r?\n/)) {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!data.length) continue;
    try {
      out.push(JSON.parse(data.join('\n')));
    } catch {
      // ignore non-JSON events
    }
  }
  return out;
}
