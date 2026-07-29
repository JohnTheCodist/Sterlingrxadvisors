import { useState, useRef, useEffect, Fragment } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

const STARTER_QUESTIONS = [
  'How much did I sell?',
  'Is the business growing?',
  'Which products make the most profit?',
  'Why did sales change?',
  "What's my biggest risk right now?",
];

// The advisor's LLM naturally writes markdown (bold, italics, inline code,
// headers, tables, lists, dividers). This is a small dependency-free
// renderer for just the subset it actually produces — not a general
// markdown parser.
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} className="font-semibold text-[var(--color-ink)]">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${keyPrefix}-${i}`} className="rounded bg-[var(--color-bg-alt)] px-1.5 py-0.5 font-mono text-[0.85em] text-[var(--color-primary)]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 1) {
      return <em key={`${keyPrefix}-${i}`} className="italic">{part.slice(1, -1)}</em>;
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

function renderMarkdownLite(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(-{3,}|—{3,})\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} className="my-3 border-t border-[var(--color-line)]" />);
      i++;
      continue;
    }

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
        <div key={blocks.length} className="my-2.5 overflow-x-auto rounded-lg border border-[var(--color-line)]">
          <table className="w-full text-xs border-collapse">
            {header && (
              <thead>
                <tr className="bg-[var(--color-bg-alt)]">
                  {header.map((c, j) => (
                    <th key={j} className="px-3 py-1.5 text-left font-semibold text-[var(--color-ink)] border-b border-[var(--color-line)]">{renderInline(c, `h${j}`)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className={r % 2 === 1 ? 'bg-[var(--color-bg-alt)]/40' : ''}>
                  {row.map((c, j) => (
                    <td key={j} className="px-3 py-1.5 text-[var(--color-ink-soft)] border-b border-[var(--color-line)]/50 last:border-b-0">{renderInline(c, `r${r}c${j}`)}</td>
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
        <ul key={blocks.length} className="my-1.5 space-y-1 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-ink-faint)]" />
              <span>{renderInline(it, `ul${j}`)}</span>
            </li>
          ))}
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
        <ol key={blocks.length} className="my-1.5 space-y-1.5 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2.5">
              <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[10px] font-bold text-[var(--color-primary)]">{j + 1}</span>
              <span className="pt-px">{renderInline(it, `ol${j}`)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = heading[1].length;
      const cls = level <= 2
        ? 'text-[13px] font-bold tracking-tight'
        : 'text-[12px] font-semibold';
      blocks.push(
        <p key={blocks.length} className={`${cls} mt-3 mb-1.5 first:mt-0 text-[var(--color-ink)]`}>
          {renderInline(heading[2], `hd${blocks.length}`)}
        </p>
      );
      i++;
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    blocks.push(<p key={blocks.length} className="my-1.5 first:mt-0 last:mb-0">{renderInline(line, `p${blocks.length}`)}</p>);
    i++;
  }

  return blocks;
}

function AdvisorAvatar() {
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    </div>
  );
}

function Bubble({ role, content, streaming = false }) {
  const isUser = role === 'user';
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--color-primary)] px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start gap-2">
      <AdvisorAvatar />
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-ink)] shadow-sm">
        {renderMarkdownLite(content)}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-[var(--color-primary)]" />}
      </div>
    </div>
  );
}

export default function AdvisorChat() {
  const [messages, setMessages] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  // Conversation is persisted server-side (advisor_message table) — load it
  // once on mount so reloading the page or switching tabs doesn't wipe it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/advisor-chat/history');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.messages)) setMessages(data.messages);
      } catch (_) {
        // Non-fatal — chat still works for this session, just without prior history.
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, streamingText]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || loading) return;

    const nextMessages = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setStreamingText('');
    setLoading(true);

    try {
      const res = await apiFetch('/api/advisor-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Advisor request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      let streamError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const raw of events) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }

          if (evt.type === 'token') {
            assembled += evt.token;
            setStreamingText(assembled);
          } else if (evt.type === 'error') {
            streamError = evt.error;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      setMessages([...nextMessages, { role: 'assistant', content: assembled }]);
      setStreamingText('');
    } catch (err) {
      setError(err.message);
      setMessages(nextMessages);
      setStreamingText('');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    send();
  };

  const startNewChat = async () => {
    if (loading) return;
    try {
      await apiFetch('/api/advisor-chat/new', { method: 'POST' });
    } catch (_) {
      // Non-fatal — worst case the next message still lands in the old
      // conversation rather than blocking the user from starting fresh.
    }
    setMessages([]);
    setStreamingText('');
    setError('');
  };

  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] h-[70vh] min-h-[480px]">
      <div className="px-5 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-[var(--color-ink)]">AI Advisor</p>
          <p className="text-[11px] text-[var(--color-ink-faint)]">Ask anything about your data</p>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          disabled={loading}
          className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors disabled:opacity-50"
        >
          New chat
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.length === 0 && historyLoaded && (
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

        {loading && streamingText && (
          <Bubble role="assistant" content={streamingText} streaming />
        )}

        {loading && !streamingText && (
          <div className="flex justify-start gap-2">
            <AdvisorAvatar />
            <div className="rounded-2xl rounded-bl-sm border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 shadow-sm">
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
