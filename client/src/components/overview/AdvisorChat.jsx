import { useState, useRef, useEffect, Fragment } from 'react';

const STARTER_QUESTIONS = [
  'How much did I sell?',
  'Is the business growing?',
  'Which products make the most profit?',
  'Why did sales change?',
  "What's my biggest risk right now?",
];

// The advisor's LLM naturally writes markdown (bold, headers, tables,
// lists). This is a small dependency-free renderer for just the subset it
// actually produces — not a general markdown parser.
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      : <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
  );
}

function renderMarkdownLite(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines
        .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));
      const [header, ...body] = rows;
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto my-2">
          <table className="text-xs border-collapse">
            {header && (
              <thead>
                <tr>
                  {header.map((c, j) => (
                    <th key={j} className="border-b border-[var(--color-line)] px-2 py-1 text-left font-semibold">{renderInline(c, `h${j}`)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} className="border-b border-[var(--color-line)]/60 px-2 py-1">{renderInline(c, `r${r}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*[-•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-•]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="list-disc pl-4 space-y-0.5 my-1">
          {items.map((it, j) => <li key={j}>{renderInline(it, `ul${j}`)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="list-decimal pl-4 space-y-0.5 my-1">
          {items.map((it, j) => <li key={j}>{renderInline(it, `ol${j}`)}</li>)}
        </ol>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const size = heading[1].length >= 3 ? 'text-sm' : 'text-base';
      blocks.push(<p key={blocks.length} className={`${size} font-semibold mt-2 mb-1`}>{renderInline(heading[2], `hd${blocks.length}`)}</p>);
      i++;
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    blocks.push(<p key={blocks.length} className="my-1">{renderInline(line, `p${blocks.length}`)}</p>);
    i++;
  }

  return blocks;
}

function Bubble({ role, content }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-[var(--color-primary)] text-primary-foreground rounded-br-sm whitespace-pre-wrap'
            : 'bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-ink)] rounded-bl-sm'
        }`}
      >
        {isUser ? content : renderMarkdownLite(content)}
      </div>
    </div>
  );
}

export default function AdvisorChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || loading) return;

    const nextMessages = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/advisor-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Advisor request failed');
      setMessages([...nextMessages, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setError(err.message);
      setMessages(nextMessages);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    send();
  };

  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] h-[70vh] min-h-[480px]">
      <div className="px-5 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">AI Advisor</p>
          <p className="text-[11px] text-[var(--color-ink-faint)]">Ask anything about your data</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4">
            <p className="text-sm text-[var(--color-ink-faint)] max-w-xs">
              Ask about revenue, margins, stock, customers, or what to do next — answers are grounded in your uploaded data.
            </p>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)] animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)] animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)] animate-bounce" />
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm border border-destructive/20 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-[var(--color-line)] p-3 flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your business..."
          className="flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:outline-none focus:border-[var(--color-primary)]"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-primary-foreground disabled:opacity-40 transition"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}
