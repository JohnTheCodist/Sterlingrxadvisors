import { useState, useRef, useEffect, Fragment, useCallback } from 'react';
import { apiFetch } from '../../lib/apiClient.js';
import { useAuth } from '../../context/AuthContext.jsx';

// Locally cached transcript so reopening the Advisor paints instantly
// instead of showing an empty panel until the round trip finishes; the
// fetch still runs and reconciles in the background.
//
// The key is namespaced by organization on purpose — a shared browser must
// never flash one pharmacy's conversation to whoever signs in next.
const CACHE_VERSION = 'v1';
const cacheKey = (organizationId) => `rxnaija.advisor.${CACHE_VERSION}.${organizationId || 'anon'}`;

function readCache(organizationId) {
  if (!organizationId) return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(organizationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch (_) {
    return null; // corrupt or unavailable storage is never fatal here
  }
}

function writeCache(organizationId, conversationId, messages) {
  if (!organizationId) return;
  try {
    window.localStorage.setItem(
      cacheKey(organizationId),
      JSON.stringify({ conversationId, messages, savedAt: Date.now() })
    );
  } catch (_) {
    // Quota exceeded or storage disabled — the server copy is authoritative.
  }
}

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

// Shown only when there's nothing cached to paint — a shaped placeholder
// reads as "content is coming" where a blank panel reads as "broken".
function ChatSkeleton() {
  const rows = [
    { side: 'right', w: '42%' },
    { side: 'left', w: '78%' },
    { side: 'left', w: '55%' },
    { side: 'right', w: '35%' },
    { side: 'left', w: '68%' },
  ];
  return (
    <div className="space-y-5" aria-hidden="true">
      {rows.map((r, i) => (
        <div key={i} className={`flex ${r.side === 'right' ? 'justify-end' : 'justify-start'}`}>
          <div
            className="advisor-shimmer rounded-2xl"
            style={{ width: r.w, height: r.side === 'left' ? 56 : 34 }}
          />
        </div>
      ))}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-2" aria-hidden="true">
      {[72, 88, 64, 80].map((w, i) => (
        <div key={i} className="advisor-shimmer h-8 rounded-lg" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export default function AdvisorChat({ analysisContext = null }) {
  const { organization } = useAuth();
  const organizationId = organization?.organizationId || null;

  // Seed straight from cache during the very first render so returning to
  // the Advisor paints the previous conversation immediately rather than
  // after a round trip.
  const [messages, setMessages] = useState(() => readCache(organizationId)?.messages || []);
  const [conversationId, setConversationId] = useState(() => readCache(organizationId)?.conversationId || null);
  // Only a cold start (nothing cached) should show skeletons.
  const [historyLoaded, setHistoryLoaded] = useState(() => !!readCache(organizationId));
  const [conversations, setConversations] = useState([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await apiFetch('/api/advisor-chat/conversations');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
    } catch (_) {
      // Sidebar is an enhancement — its failure must not block the chat.
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  // Conversation is persisted server-side (advisor_message table) — load it
  // on mount so reloading the page or switching tabs doesn't wipe it. Any
  // cached copy is already on screen; this reconciles it with the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/advisor-chat/history');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
          setConversationId(data.conversationId || null);
          writeCache(organizationId, data.conversationId, data.messages);
        }
      } catch (_) {
        // Non-fatal — chat still works for this session, just without prior history.
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    refreshConversations();
    return () => { cancelled = true; };
  }, [organizationId, refreshConversations]);

  const selectConversation = async (id) => {
    if (loading || id === conversationId) { setSidebarOpen(false); return; }
    setSwitching(true);
    setError('');
    setStreamingText('');
    setSidebarOpen(false);
    try {
      const res = await apiFetch(`/api/advisor-chat/history?conversationId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Could not open that conversation.');
      const data = await res.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setConversationId(data.conversationId || id);
      writeCache(organizationId, data.conversationId || id, data.messages || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSwitching(false);
    }
  };

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
        // Send the on-screen conversation's id so a reply lands in the
        // thread the user is actually looking at, not whichever one the
        // server considers active.
        // analysisContext is what the dashboard is currently showing. Sending
        // it makes those figures authoritative, so the Advisor can't answer
        // with a number that contradicts what's on screen.
        body: JSON.stringify({ message: question, conversationId, analysisContext }),
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
      const finalMessages = [...nextMessages, { role: 'assistant', content: assembled }];
      setMessages(finalMessages);
      setStreamingText('');
      writeCache(organizationId, conversationId, finalMessages);
      // The first message in a thread is what the sidebar titles it by, so
      // refresh the list once the exchange completes.
      refreshConversations();
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
      const res = await apiFetch('/api/advisor-chat/new', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      setConversationId(data.conversationId || null);
      writeCache(organizationId, data.conversationId || null, []);
    } catch (_) {
      // Non-fatal — worst case the next message still lands in the old
      // conversation rather than blocking the user from starting fresh.
    }
    setMessages([]);
    setStreamingText('');
    setError('');
    setSidebarOpen(false);
    refreshConversations();
  };

  const conversationList = (
    <>
      <button
        type="button"
        onClick={startNewChat}
        disabled={loading}
        className="mb-3 flex w-full items-center gap-2 rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs font-medium text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-50"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New chat
      </button>

      <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Recent</p>

      {!conversationsLoaded ? (
        <SidebarSkeleton />
      ) : conversations.length === 0 ? (
        <p className="px-2 text-[11px] text-[var(--color-ink-faint)]">No conversations yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {conversations.map((c) => {
            const isCurrent = c.id === conversationId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => selectConversation(c.id)}
                  disabled={loading}
                  aria-current={isCurrent ? 'true' : undefined}
                  title={c.title}
                  className={`w-full truncate rounded-lg px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                    isCurrent
                      ? 'bg-[var(--color-primary-tint)] font-medium text-[var(--color-primary)]'
                      : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-bg-alt)]'
                  }`}
                >
                  {c.title}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <div className="relative flex overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] h-[70vh] min-h-[480px]">
      {/* Conversation history — inline from md up, slide-over on small screens */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-bg-alt)]/40 p-3 md:flex">
        {conversationList}
      </aside>

      {sidebarOpen && (
        <div className="absolute inset-0 z-20 flex md:hidden">
          <div className="absolute inset-0 bg-black/20" onClick={() => setSidebarOpen(false)} />
          <aside className="relative z-10 flex h-full w-60 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-bg)] p-3 shadow-xl">
            {conversationList}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
      <div className="px-5 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Show conversation history"
          className="-ml-1 mr-0.5 rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-primary)] md:hidden"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">AI Advisor</p>
          <p className="text-[11px] text-[var(--color-ink-faint)]">Ask anything about your data</p>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          disabled={loading}
          className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors disabled:opacity-50 md:hidden"
        >
          New chat
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {/* Cold start (nothing cached) or mid-switch: shaped placeholders
            rather than an empty panel, so it reads as loading not broken. */}
        {(!historyLoaded || switching) && messages.length === 0 && <ChatSkeleton />}

        {messages.length === 0 && historyLoaded && !switching && (
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
    </div>
  );
}
